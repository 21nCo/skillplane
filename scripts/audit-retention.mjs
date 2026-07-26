#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { runAuditRetention } from "../packages/observability/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function positiveInteger(name, fallback) {
  const raw = option(name);
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

async function databaseUrl() {
  const configured = process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL;
  if (configured) return configured;
  const runtime = JSON.parse(
    await readFile(resolve(repoRoot, ".data", "local-runtime.json"), "utf8"),
  );
  if (typeof runtime.databaseUrl !== "string") {
    throw new Error("Local runtime does not contain databaseUrl");
  }
  return runtime.databaseUrl;
}

const pool = new Pool({
  connectionString: await databaseUrl(),
  application_name: "skillplane-audit-retention",
  max: 4,
});

try {
  const result = await runAuditRetention(pool, {
    retentionDays: positiveInteger("--retention-days", 90),
    batchSize: positiveInteger("--batch-size", 1_000),
    dryRun: args.includes("--dry-run"),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} finally {
  await pool.end();
}
