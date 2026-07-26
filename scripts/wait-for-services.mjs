#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runtimePath = join(repoRoot, ".data", "local-runtime.json");
const timeoutMilliseconds = 60_000;
const retryMilliseconds = 500;

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function containerHealth() {
  try {
    return execFileSync(
      "docker",
      [
        "inspect",
        "--format",
        "{{if .State.Health}}{{.State.Health.Status}}{{else}}missing{{end}}",
        "skillplane-postgres",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "missing";
  }
}

let runtime;
try {
  runtime = JSON.parse(await readFile(runtimePath, "utf8"));
} catch {
  process.stderr.write(
    `${JSON.stringify({
      ok: false,
      code: "LOCAL_RUNTIME_MISSING",
      message: "Run pnpm db:up before waiting for services",
    })}\n`,
  );
  process.exit(28);
}

const deadline = Date.now() + timeoutMilliseconds;
let lastDatabaseCode = "NOT_ATTEMPTED";

while (Date.now() < deadline) {
  const health = containerHealth();
  if (health === "healthy") {
    const client = new Client({
      connectionString: runtime.databaseUrl,
      connectionTimeoutMillis: 2_000,
      query_timeout: 2_000,
    });

    try {
      await client.connect();
      const result = await client.query(
        "select current_database() as database, current_user as application_user, current_setting('server_version_num') as server_version",
      );
      const row = result.rows[0];
      await client.end();
      emit({
        ok: true,
        postgres: {
          container: "skillplane-postgres",
          health,
          host: "127.0.0.1",
          port: runtime.port,
          database: row.database,
          applicationUser: row.application_user,
          serverVersion: row.server_version,
        },
      });
      process.exit(0);
    } catch (error) {
      lastDatabaseCode =
        typeof error?.code === "string" ? error.code : "DATABASE_UNAVAILABLE";
      await client.end().catch(() => undefined);
    }
  }

  await new Promise((resolvePromise) => setTimeout(resolvePromise, retryMilliseconds));
}

process.stderr.write(
  `${JSON.stringify({
    ok: false,
    code: "SERVICES_NOT_READY",
    message: "Postgres did not become queryable before the timeout",
    details: {
      containerHealth: containerHealth(),
      databaseCode: lastDatabaseCode,
    },
  })}\n`,
);
process.exit(29);
