#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { developmentDatabase } from "./lib/development-deployment.mjs";
import { root, run } from "./lib/production-deployment.mjs";

export function migrateDevelopment() {
  const database = developmentDatabase();
  run("pnpm", ["--filter", "@skillplane/db", "migrate"], {
    cwd: root,
    env: { ...process.env, MIGRATION_DATABASE_URL: database.url, DATABASE_URL: "" },
    failureMessage: "Development database migration failed",
  });
  run("pnpm", ["--filter", "@skillplane/db", "verify"], {
    cwd: root,
    env: { ...process.env, DATABASE_URL: database.url, MIGRATION_DATABASE_URL: "" },
    failureMessage: "Development database verification failed",
  });
  return {
    ok: true,
    environment: "development",
    databaseFingerprint: database.fingerprint,
  };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(migrateDevelopment(), null, 2)}\n`);
}
