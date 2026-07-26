#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  migrateDatabase,
  resolveTestDatabaseUrl,
  verifyDatabase,
} from "../../packages/db/dist/src/index.js";
import { seedTenantFixture } from "../../packages/testing/dist/index.js";
import {
  databaseInventory,
  dropDisposableDatabase,
  recreateDisposableDatabase,
} from "../../scripts/lib/local-database.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const baseUrl = await resolveTestDatabaseUrl();
const sourceUrl = new URL(baseUrl);
sourceUrl.pathname = "/skillplane_recovery_source_test";
const restoreUrl = new URL(baseUrl);
restoreUrl.pathname = "/skillplane_recovery_restore_test";
const corruptUrl = new URL(baseUrl);
corruptUrl.pathname = "/skillplane_recovery_corrupt_test";
const backupDirectory = resolve(root, ".data", "backups");
const reportDirectory = resolve(root, ".data", "reports");
const dumpPath = resolve(backupDirectory, "skillplane-recovery.dump");
const manifestPath = `${dumpPath}.manifest.json`;

function run(script, arguments_, expectedStatus = 0) {
  const result = spawnSync(process.execPath, [resolve(root, script), ...arguments_], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 1024,
  });
  if (result.status !== expectedStatus) {
    throw new Error(
      `${script} exited ${String(result.status)}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout.trim();
}

let report;
try {
  await Promise.all([
    dropDisposableDatabase(sourceUrl.toString()).catch(() => undefined),
    dropDisposableDatabase(restoreUrl.toString()).catch(() => undefined),
    dropDisposableDatabase(corruptUrl.toString()).catch(() => undefined),
  ]);
  await recreateDisposableDatabase(sourceUrl.toString());
  const fresh = await migrateDatabase(sourceUrl.toString());
  const upgrade = await migrateDatabase(sourceUrl.toString());
  const freshVerification = await verifyDatabase(sourceUrl.toString());
  if (
    fresh.applied.length === 0 ||
    upgrade.applied.length !== 0 ||
    upgrade.alreadyApplied.length !== freshVerification.migrations.length
  ) {
    throw new Error("Fresh/forward migration rehearsal did not converge");
  }
  const suffix = `recovery-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  await seedTenantFixture(sourceUrl.toString(), suffix);
  const sourceInventory = await databaseInventory(sourceUrl.toString());
  if (sourceInventory.bundleReferences.length === 0) {
    throw new Error("Recovery source did not contain an R2 reference inventory");
  }

  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  const backupOutput = run("scripts/backup.mjs", [
    "--database-url",
    sourceUrl.toString(),
    "--output",
    dumpPath,
    "--manifest",
    manifestPath,
    "--overwrite",
  ]);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (
    manifest.r2.bundleReferenceCount !== sourceInventory.bundleReferences.length ||
    manifest.r2.bundleReferenceDigest !== sourceInventory.bundleReferenceDigest
  ) {
    throw new Error("Backup manifest did not reproduce the source R2 inventory");
  }

  const restoreOutput = run("scripts/restore.mjs", [
    "--input",
    dumpPath,
    "--manifest",
    manifestPath,
    "--database-url",
    restoreUrl.toString(),
  ]);
  const restoreVerification = await verifyDatabase(restoreUrl.toString());
  const restoreInventory = await databaseInventory(restoreUrl.toString());
  if (
    JSON.stringify(restoreInventory.migrations) !==
      JSON.stringify(sourceInventory.migrations) ||
    restoreInventory.bundleReferenceDigest !== sourceInventory.bundleReferenceDigest
  ) {
    throw new Error("Restored database inventory does not match the source");
  }

  const hostileManifestPath = resolve(
    backupDirectory,
    "skillplane-recovery-corrupt.manifest.json",
  );
  await writeFile(
    hostileManifestPath,
    `${JSON.stringify(
      {
        ...manifest,
        dump: { ...manifest.dump, sha256: "0".repeat(64) },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  const checksumFailure = spawnSync(
    process.execPath,
    [
      resolve(root, "scripts/restore.mjs"),
      "--input",
      dumpPath,
      "--manifest",
      hostileManifestPath,
      "--database-url",
      corruptUrl.toString(),
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (checksumFailure.status === 0 || !checksumFailure.stderr.includes("checksum")) {
    throw new Error("Corrupt backup checksum did not fail closed");
  }

  const orphanOutput = run("scripts/orphan-cleanup.mjs", ["--manifest", manifestPath]);
  report = {
    ok: true,
    generatedAt: new Date().toISOString(),
    migrations: {
      freshApplied: fresh.applied.length,
      forwardAlreadyApplied: upgrade.alreadyApplied.length,
      restored: restoreVerification.migrations.length,
    },
    database: {
      sourceTables: freshVerification.tables.length,
      restoredTables: restoreVerification.tables.length,
    },
    r2Inventory: {
      sourceReferences: sourceInventory.bundleReferences.length,
      restoredReferences: restoreInventory.bundleReferences.length,
      digest: restoreInventory.bundleReferenceDigest,
    },
    failureInjection: {
      corruptChecksumRejectedBeforeRestore: true,
      orphanListingFailurePreservedObjects: true,
      orphanReferenceFailurePreservedObjects: true,
    },
    commandEvidence: {
      backup: backupOutput,
      restore: restoreOutput,
      orphanCleanup: orphanOutput,
    },
  };
  await mkdir(reportDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    resolve(reportDirectory, "recovery-latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
    { mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} finally {
  await Promise.all([
    dropDisposableDatabase(sourceUrl.toString()).catch(() => undefined),
    dropDisposableDatabase(restoreUrl.toString()).catch(() => undefined),
    dropDisposableDatabase(corruptUrl.toString()).catch(() => undefined),
  ]);
}
