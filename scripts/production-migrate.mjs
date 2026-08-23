#!/usr/bin/env node

import { resolve } from "node:path";
import { Pool } from "pg";
import {
  capture,
  isMain,
  postgresTlsEvidence,
  productionStateDirectory,
  productionDatabase,
  readJson,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";

async function verifySsl(database) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-production-migration-preflight",
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const client = await pool.connect();
    try {
      const result = await client.query(
        "SELECT ssl, version, cipher, bits FROM pg_stat_ssl WHERE pid = pg_backend_pid()",
      );
      return postgresTlsEvidence(client, result.rows[0]);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function requireFreshBackup(database) {
  let backup;
  try {
    backup = await readJson(resolve(productionStateDirectory, "backup.json"));
  } catch {
    throw new Error(
      "A verified production backup is required before direct database migration",
    );
  }
  const createdAt = Date.parse(backup.createdAt);
  if (
    backup.ok !== true ||
    backup.databaseFingerprint !== database.fingerprint ||
    backup.restoreListVerified !== true ||
    !Number.isFinite(createdAt) ||
    Date.now() - createdAt < 0 ||
    Date.now() - createdAt > 24 * 60 * 60 * 1000
  ) {
    throw new Error(
      "The production backup is stale, invalid, or belongs to another database",
    );
  }
  return backup;
}

function parseCommandJson(output, name) {
  try {
    const start = output.lastIndexOf("\n{");
    return JSON.parse(start >= 0 ? output.slice(start + 1) : output);
  } catch {
    throw new Error(`${name} did not return a valid verification record`);
  }
}

export async function migrateProductionDatabase(options = {}) {
  const database = options.database ?? productionDatabase();
  const backup = await requireFreshBackup(database);
  const ssl = await verifySsl(database);
  const environment = { ...process.env, MIGRATION_DATABASE_URL: database.url };
  delete environment.DATABASE_URL;
  const migration = parseCommandJson(
    capture("pnpm", ["--filter", "@skillplane/db", "migrate"], {
      env: environment,
      failureMessage: "Production migrations failed",
    }).stdout,
    "Production migration",
  );
  const verification = parseCommandJson(
    capture("pnpm", ["--filter", "@skillplane/db", "verify"], {
      env: environment,
      failureMessage: "Production database verification failed",
    }).stdout,
    "Production verification",
  );
  const state = {
    ok: migration.ok === true && verification.ok === true,
    createdAt: new Date().toISOString(),
    databaseFingerprint: database.fingerprint,
    backupSha256: backup.encryptedSha256,
    backupCreatedAt: backup.createdAt,
    ssl,
    applied: migration.applied,
    alreadyApplied: migration.alreadyApplied,
    migrationCount: verification.migrations?.length ?? 0,
    tableCount: verification.tables?.length ?? 0,
    constraintCount: verification.constraints?.length ?? 0,
    triggerCount: verification.triggers?.length ?? 0,
    queryPlans: verification.queryPlans,
  };
  if (!state.ok) {
    throw new Error("Production database migration verification did not pass");
  }
  await writeJsonAtomic(resolve(productionStateDirectory, "migration.json"), state, {
    mode: 0o600,
  });
  return state;
}

if (isMain(import.meta.url)) {
  const result = await migrateProductionDatabase();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
