#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { rollupUtcDay } from "../packages/observability/dist/index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

function option(name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function yesterdayUtc() {
  const value = new Date(Date.now() - 86_400_000);
  return value.toISOString().slice(0, 10);
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

const day = option("--day") ?? yesterdayUtc();
const workspaceId = option("--workspace");
const pool = new Pool({
  connectionString: await databaseUrl(),
  application_name: "skillplane-analytics-rollup",
  max: 4,
});

try {
  const result = await rollupUtcDay(pool, {
    day,
    ...(workspaceId ? { workspaceId } : {}),
  });
  process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
} finally {
  await pool.end();
}
