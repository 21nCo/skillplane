#!/usr/bin/env node

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { Pool } from "pg";
import {
  isMain,
  portablePath,
  postgresTlsEvidence,
  productionStateDirectory,
  productionDatabase,
  requireSecretEnvironment,
  sha256,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";

async function openBackupSnapshot(database) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-production-backup-inventory",
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  const client = await pool.connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const ssl = await client.query(
      "SELECT ssl, version, cipher, bits FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
    );
    const tls = postgresTlsEvidence(client, ssl.rows[0]);
    const snapshot = await client.query(
      "SELECT pg_export_snapshot()::text AS snapshot",
    );
    const server = await client.query(
      `SELECT current_setting('server_version')::text AS version,
              current_setting('server_version_num')::integer AS version_num`,
    );
    const serverMajor = Math.floor(Number(server.rows[0]?.version_num) / 10_000);
    if (!Number.isInteger(serverMajor) || serverMajor < 15 || serverMajor > 18) {
      throw new Error("The PostgreSQL server major version is not supported");
    }
    const relations = await client.query(
      `SELECT to_regclass('public.skillplane_schema_migrations')::text AS migrations,
              to_regclass('public.skill_versions')::text AS versions`,
    );
    const hasMigrations = Boolean(relations.rows[0]?.migrations);
    const hasVersions = Boolean(relations.rows[0]?.versions);
    const migrations = hasMigrations
      ? (
          await client.query(
            "SELECT id, sha256 FROM skillplane_schema_migrations ORDER BY id",
          )
        ).rows
      : [];
    const bundleReferences = hasVersions
      ? (
          await client.query(
            `SELECT id AS version_id, workspace_id, skill_id, content_digest,
                    r2_object_key, bundle_byte_size::text
               FROM skill_versions
              ORDER BY workspace_id, skill_id, revision, id`,
          )
        ).rows.map((row) => ({
          versionId: row.version_id,
          workspaceId: row.workspace_id,
          skillId: row.skill_id,
          digest: row.content_digest,
          objectKey: row.r2_object_key,
          byteSize: row.bundle_byte_size,
        }))
      : [];
    return {
      snapshot: snapshot.rows[0]?.snapshot,
      inventory: {
        ssl: tls,
        migrations,
        bundleReferences,
        bundleReferenceDigest: sha256(
          Buffer.from(JSON.stringify(bundleReferences), "utf8"),
        ),
        postgres: {
          serverVersion: server.rows[0]?.version ?? "unknown",
          serverMajor,
          clientImage: `postgres:${serverMajor}-alpine`,
        },
      },
      close: async () => {
        await client.query("ROLLBACK").catch(() => undefined);
        client.release();
        await pool.end();
      },
    };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    client.release();
    await pool.end();
    throw error;
  }
}

function dumpPostgres(database, snapshot, clientImage) {
  if (typeof snapshot !== "string" || !/^[0-9A-Fa-f-]+$/u.test(snapshot)) {
    throw new Error("Postgres did not provide a valid exported backup snapshot");
  }
  const script = [
    "IFS= read -r PGPASSWORD",
    "export PGPASSWORD PGSSLMODE=require",
    'exec pg_dump "$@"',
  ].join("\n");
  const result = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-i",
      clientImage,
      "sh",
      "-ec",
      script,
      "--",
      "--host",
      database.identity.host,
      "--port",
      database.identity.port,
      "--username",
      database.identity.username,
      "--dbname",
      database.identity.database,
      "--format=custom",
      "--snapshot",
      snapshot,
      "--no-owner",
      "--no-privileges",
    ],
    {
      input: `${database.password}\n`,
      encoding: null,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("The encrypted PostgreSQL pg_dump operation failed");
  }
  if (!Buffer.isBuffer(result.stdout) || result.stdout.byteLength === 0) {
    throw new Error("pg_dump produced an empty backup");
  }
  return result.stdout;
}

function encryptDump(dump, passphrase) {
  const salt = randomBytes(32);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: 1 << 17,
    r: 8,
    p: 1,
    maxmem: 256 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
  return {
    encrypted,
    encryption: {
      algorithm: "aes-256-gcm",
      keyDerivation: "scrypt",
      scrypt: { N: 1 << 17, r: 8, p: 1 },
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
    },
  };
}

function verifyProtectedDump(protectedDump, passphrase, expectedDump, clientImage) {
  const encryption = protectedDump.encryption;
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
  const decrypted = Buffer.concat([
    decipher.update(protectedDump.encrypted),
    decipher.final(),
  ]);
  if (
    decrypted.byteLength !== expectedDump.byteLength ||
    sha256(decrypted) !== sha256(expectedDump)
  ) {
    throw new Error("The encrypted production backup failed round-trip verification");
  }
  const listed = spawnSync(
    "docker",
    ["run", "--rm", "-i", clientImage, "pg_restore", "--list"],
    {
      input: decrypted,
      encoding: null,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  if (listed.error) throw listed.error;
  if (listed.status !== 0 || !Buffer.isBuffer(listed.stdout)) {
    throw new Error("pg_restore could not read the encrypted backup archive");
  }
  const restoreList = listed.stdout.toString("utf8");
  if (!restoreList.includes("Dumped from database version")) {
    throw new Error("The production backup archive inventory is invalid");
  }
  return restoreList.split("\n").filter((line) => /^\d+;/u.test(line)).length;
}

export async function backupProductionDatabase(options = {}) {
  const database = options.database ?? productionDatabase();
  const passphrase = requireSecretEnvironment("SKILLPLANE_BACKUP_ENCRYPTION_KEY");
  const source = await openBackupSnapshot(database);
  let dump;
  try {
    dump = dumpPostgres(
      database,
      source.snapshot,
      source.inventory.postgres.clientImage,
    );
  } finally {
    await source.close();
  }
  const inventory = source.inventory;
  const protectedDump = encryptDump(dump, passphrase);
  const restoreEntryCount = verifyProtectedDump(
    protectedDump,
    passphrase,
    dump,
    inventory.postgres.clientImage,
  );
  const timestamp = new Date().toISOString();
  const basename = `skillplane-${timestamp.replaceAll(/[:.]/gu, "-")}`;
  const directory = resolve(productionStateDirectory, "backups");
  const output = resolve(directory, `${basename}.dump.enc`);
  const manifestPath = resolve(directory, `${basename}.manifest.json`);
  const temporaryOutput = `${output}.tmp`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await writeFile(temporaryOutput, protectedDump.encrypted, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporaryOutput, output);
  } catch (error) {
    await unlink(temporaryOutput).catch(() => undefined);
    throw error;
  }
  const manifest = {
    formatVersion: 1,
    createdAt: timestamp,
    source: {
      provider: "postgresql",
      host: database.identity.host,
      port: database.identity.port,
      database: database.identity.database,
      databaseFingerprint: database.fingerprint,
      ssl: inventory.ssl,
      postgres: inventory.postgres,
    },
    dump: {
      format: "postgres-custom",
      plaintextSha256: sha256(dump),
      plaintextByteSize: dump.byteLength,
      encryptedSha256: sha256(protectedDump.encrypted),
      encryptedByteSize: protectedDump.encrypted.byteLength,
      encryption: protectedDump.encryption,
      postgresClientImage: inventory.postgres.clientImage,
      restoreListVerified: true,
      restoreEntryCount,
    },
    migrations: inventory.migrations,
    r2: {
      bundleReferenceCount: inventory.bundleReferences.length,
      bundleReferenceDigest: inventory.bundleReferenceDigest,
    },
  };
  await writeJsonAtomic(manifestPath, manifest, {
    mode: 0o600,
    exclusive: true,
  });
  const state = {
    ok: true,
    createdAt: timestamp,
    databaseFingerprint: database.fingerprint,
    backup: portablePath(output),
    manifest: portablePath(manifestPath),
    encryptedSha256: manifest.dump.encryptedSha256,
    migrationCount: manifest.migrations.length,
    bundleReferenceCount: manifest.r2.bundleReferenceCount,
    restoreListVerified: true,
    restoreEntryCount,
    ssl: manifest.source.ssl,
  };
  await writeJsonAtomic(resolve(productionStateDirectory, "backup.json"), state, {
    mode: 0o600,
  });
  return state;
}

if (isMain(import.meta.url)) {
  const result = await backupProductionDatabase();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
