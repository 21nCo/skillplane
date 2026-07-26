#!/usr/bin/env node

import { createDecipheriv, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { Pool } from "pg";
import { parseArguments } from "./lib/local-database.mjs";
import {
  capture,
  isMain,
  parseRailwayDatabaseUrl,
  portablePath,
  productionStateDirectory,
  readJson,
  requireEnvironment,
  requireSecretEnvironment,
  sha256,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";

function protectedDumpPath(manifestPath, explicit) {
  if (explicit) return resolve(explicit);
  if (!manifestPath.endsWith(".manifest.json")) {
    throw new Error("--backup is required when the manifest name is non-standard");
  }
  return manifestPath.slice(0, -".manifest.json".length) + ".dump.enc";
}

function decryptBackup(manifest, encrypted, passphrase) {
  const encryption = manifest.dump?.encryption;
  if (
    encryption?.algorithm !== "aes-256-gcm" ||
    encryption.keyDerivation !== "scrypt" ||
    encryption.scrypt?.N !== 1 << 17 ||
    encryption.scrypt?.r !== 8 ||
    encryption.scrypt?.p !== 1
  ) {
    throw new Error("The backup manifest uses an unsupported encryption contract");
  }
  if (sha256(encrypted) !== manifest.dump.encryptedSha256) {
    throw new Error("The encrypted backup digest does not match its manifest");
  }
  const key = scryptSync(passphrase, Buffer.from(encryption.salt, "base64"), 32, {
    ...encryption.scrypt,
    maxmem: 256 * 1024 * 1024,
  });
  const decipher = createDecipheriv(
    encryption.algorithm,
    key,
    Buffer.from(encryption.iv, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encryption.authTag, "base64"));
  const dump = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (
    dump.byteLength !== manifest.dump.plaintextByteSize ||
    sha256(dump) !== manifest.dump.plaintextSha256
  ) {
    throw new Error("The decrypted backup digest does not match its manifest");
  }
  return dump;
}

async function assertEmptyRecoveryTarget(database, confirmedName, sourceFingerprint) {
  if (database.identity.database !== confirmedName) {
    throw new Error(
      "--confirm-empty-database must exactly match the recovery database name",
    );
  }
  if (database.fingerprint === sourceFingerprint) {
    throw new Error("Refusing to restore into the production source database");
  }
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-production-restore-preflight",
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const ssl = await pool.query(
      "SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    );
    if (ssl.rows[0]?.ssl !== true) {
      throw new Error("The recovery database connection is not protected by SSL");
    }
    const tables = await pool.query(
      `SELECT count(*)::integer AS count
         FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
    );
    if (tables.rows[0]?.count !== 0) {
      throw new Error("The recovery database is not empty");
    }
  } finally {
    await pool.end();
  }
}

function pgpassLine(database) {
  const escape = (value) => value.replaceAll("\\", "\\\\").replaceAll(":", "\\:");
  return [
    database.identity.host,
    database.identity.port,
    database.identity.database,
    database.identity.username,
    database.password,
  ]
    .map(escape)
    .join(":");
}

function restoreArchive(database, directory, clientImage) {
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--volume",
      `${directory}:/skillplane-recovery:ro`,
      "--env",
      "PGPASSFILE=/skillplane-recovery/.pgpass",
      "--env",
      "PGSSLMODE=require",
      clientImage,
      "pg_restore",
      "--exit-on-error",
      "--no-owner",
      "--no-privileges",
      "--host",
      database.identity.host,
      "--port",
      database.identity.port,
      "--username",
      database.identity.username,
      "--dbname",
      database.identity.database,
      "/skillplane-recovery/backup.dump",
    ],
    {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("pg_restore failed; discard the partial recovery database");
  }
}

async function restoredInventory(database) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-production-restore-inventory",
    max: 1,
  });
  try {
    const relations = await pool.query(
      `SELECT to_regclass('public.skillplane_schema_migrations')::text AS migrations,
              to_regclass('public.skill_versions')::text AS versions`,
    );
    const migrations = relations.rows[0]?.migrations
      ? await pool.query(
          "SELECT id, sha256 FROM skillplane_schema_migrations ORDER BY id",
        )
      : { rows: [] };
    const references = relations.rows[0]?.versions
      ? await pool.query(
          `SELECT id AS version_id, workspace_id, skill_id, content_digest,
                  r2_object_key, bundle_byte_size::text
             FROM skill_versions
            ORDER BY workspace_id, skill_id, revision, id`,
        )
      : { rows: [] };
    const bundleReferences = references.rows.map((row) => ({
      versionId: row.version_id,
      workspaceId: row.workspace_id,
      skillId: row.skill_id,
      digest: row.content_digest,
      objectKey: row.r2_object_key,
      byteSize: row.bundle_byte_size,
    }));
    return {
      migrations: migrations.rows,
      bundleReferenceCount: bundleReferences.length,
      bundleReferenceDigest: sha256(JSON.stringify(bundleReferences)),
    };
  } finally {
    await pool.end();
  }
}

function parseCommandJson(output, label) {
  try {
    const start = output.lastIndexOf("\n{");
    return JSON.parse(start >= 0 ? output.slice(start + 1) : output);
  } catch {
    throw new Error(`${label} did not return a valid verification record`);
  }
}

export async function restoreProductionBackup(arguments_ = process.argv.slice(2)) {
  const parsed = parseArguments(arguments_);
  const manifestArgument = parsed.value("manifest");
  const confirmedName = parsed.value("confirm-empty-database");
  if (!manifestArgument || !confirmedName) {
    throw new Error(
      "--manifest and --confirm-empty-database are required for a recovery drill",
    );
  }
  const manifestPath = resolve(manifestArgument);
  const backupPath = protectedDumpPath(manifestPath, parsed.value("backup"));
  const manifest = await readJson(manifestPath);
  if (
    manifest.formatVersion !== 1 ||
    !/^[a-f0-9]{64}$/u.test(manifest.source?.databaseFingerprint ?? "") ||
    !Array.isArray(manifest.migrations) ||
    typeof manifest.r2?.bundleReferenceCount !== "number" ||
    !/^[a-f0-9]{64}$/u.test(manifest.r2?.bundleReferenceDigest ?? "")
  ) {
    throw new Error("The production backup manifest is invalid");
  }
  const postgresClientImage = manifest.dump?.postgresClientImage;
  if (!/^postgres:(?:15|16|17|18)-alpine$/u.test(postgresClientImage ?? "")) {
    throw new Error("The backup manifest has an invalid Postgres client image");
  }
  const recoveryUrl = requireEnvironment("SKILLPLANE_RECOVERY_DATABASE_URL");
  const database = parseRailwayDatabaseUrl(
    recoveryUrl,
    "SKILLPLANE_RECOVERY_DATABASE_URL",
  );
  await assertEmptyRecoveryTarget(
    database,
    confirmedName,
    manifest.source?.databaseFingerprint,
  );
  const passphrase = requireSecretEnvironment("SKILLPLANE_BACKUP_ENCRYPTION_KEY");
  const encrypted = await readFile(backupPath);
  const dump = decryptBackup(manifest, encrypted, passphrase);
  await mkdir(productionStateDirectory, { recursive: true, mode: 0o700 });
  const temporaryDirectory = await mkdtemp(
    resolve(productionStateDirectory, "restore-"),
  );
  const dumpPath = resolve(temporaryDirectory, "backup.dump");
  const passPath = resolve(temporaryDirectory, ".pgpass");
  try {
    await writeFile(dumpPath, dump, { flag: "wx", mode: 0o600 });
    await writeFile(passPath, `${pgpassLine(database)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    restoreArchive(database, temporaryDirectory, postgresClientImage);
  } finally {
    await Promise.all([
      unlink(dumpPath).catch(() => undefined),
      unlink(passPath).catch(() => undefined),
    ]);
    await rmdir(temporaryDirectory).catch(() => undefined);
  }
  const inventory = await restoredInventory(database);
  if (
    sha256(JSON.stringify(inventory.migrations)) !==
      sha256(JSON.stringify(manifest.migrations)) ||
    inventory.bundleReferenceCount !== manifest.r2.bundleReferenceCount ||
    inventory.bundleReferenceDigest !== manifest.r2.bundleReferenceDigest
  ) {
    throw new Error("The restored database inventory differs from the backup");
  }
  const environment = { ...process.env, MIGRATION_DATABASE_URL: database.url };
  delete environment.DATABASE_URL;
  const upgraded = parseCommandJson(
    capture("pnpm", ["--filter", "@skillplane/db", "migrate"], {
      env: environment,
      failureMessage: "The restored database failed forward migration",
    }).stdout,
    "Recovery migration",
  );
  const verified = parseCommandJson(
    capture("pnpm", ["--filter", "@skillplane/db", "verify"], {
      env: environment,
      failureMessage: "The restored database failed schema verification",
    }).stdout,
    "Recovery verification",
  );
  if (upgraded.ok !== true || verified.ok !== true) {
    throw new Error("The recovered database did not pass forward verification");
  }
  const result = {
    ok: true,
    restoredAt: new Date().toISOString(),
    sourceManifest: portablePath(manifestPath),
    sourceBackup: basename(backupPath),
    recoveryDatabaseFingerprint: database.fingerprint,
    restoredMigrationCount: inventory.migrations.length,
    currentMigrationCount: verified.migrations?.length ?? 0,
    forwardAppliedMigrationCount: upgraded.applied?.length ?? 0,
    bundleReferenceCount: inventory.bundleReferenceCount,
    bundleReferenceDigest: inventory.bundleReferenceDigest,
    schemaVerified: true,
    forwardMigrationVerified: true,
    encryptedArchiveVerified: true,
  };
  const evidencePath = resolve(
    productionStateDirectory,
    "restore-drills",
    `${result.restoredAt.replaceAll(/[:.]/gu, "-")}.json`,
  );
  await writeJsonAtomic(evidencePath, result, {
    mode: 0o600,
    exclusive: true,
  });
  return { ...result, evidence: portablePath(evidencePath) };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await restoreProductionBackup(), null, 2)}\n`);
}
