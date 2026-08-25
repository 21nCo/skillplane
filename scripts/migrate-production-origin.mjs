#!/usr/bin/env node

import { parseArguments } from "./lib/local-database.mjs";
import {
  isMain,
  productionDatabase,
  productionMigrationSourceDatabase,
} from "./lib/production-deployment.mjs";
import { backupProductionDatabase } from "./production-backup.mjs";
import { migrateProductionDatabase } from "./production-migrate.mjs";
import { restoreProductionBackup } from "./restore-production-backup.mjs";

export async function migrateProductionOrigin(
  arguments_ = process.argv.slice(2),
  options = {},
) {
  const parsed = parseArguments(arguments_);
  const source = options.source ?? productionMigrationSourceDatabase();
  const target = options.target ?? productionDatabase();
  const confirmedSource = parsed.value("confirm-source-write-frozen");
  const confirmedTarget = parsed.value("confirm-empty-database");

  if (!confirmedSource || !confirmedTarget) {
    throw new Error(
      "--confirm-source-write-frozen and --confirm-empty-database are required",
    );
  }
  if (confirmedSource !== source.identity.database) {
    throw new Error(
      "--confirm-source-write-frozen must exactly match the source database name",
    );
  }
  if (confirmedTarget !== target.identity.database) {
    throw new Error(
      "--confirm-empty-database must exactly match the target database name",
    );
  }
  if (source.fingerprint === target.fingerprint) {
    throw new Error(
      "Production migration source and target must be different databases",
    );
  }

  const backup = await (options.backup ?? backupProductionDatabase)({
    database: source,
  });
  const restored = await (options.restore ?? restoreProductionBackup)(
    ["--manifest", backup.manifest, "--confirm-empty-database", confirmedTarget],
    { database: target },
  );
  const targetBackup = await (options.backup ?? backupProductionDatabase)({
    database: target,
  });
  const migration = await (options.migrate ?? migrateProductionDatabase)({
    database: target,
  });

  return {
    ok: restored.ok === true && migration.ok === true,
    sourceDatabaseFingerprint: source.fingerprint,
    targetDatabaseFingerprint: target.fingerprint,
    sourceBackup: backup.manifest,
    restoreEvidence: restored.evidence,
    targetBackup: targetBackup.manifest,
    targetMigrationVerifiedAt: migration.createdAt,
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await migrateProductionOrigin(), null, 2)}\n`);
}
