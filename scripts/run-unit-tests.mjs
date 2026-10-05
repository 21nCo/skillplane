#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);

const localRuntimeTests = spawnSync(
  process.execPath,
  [
    "--test",
    "scripts/lib/local-postgres-port.test.mjs",
    "scripts/lib/local-wrangler-config.test.mjs",
    "scripts/lib/local-worker-vars.test.mjs",
    "scripts/local-init.test.mjs",
    "scripts/development-deployment.test.mjs",
    "scripts/development-topology-deployment.test.mjs",
    "scripts/deploy-topology.test.mjs",
    "scripts/production-deployment.test.mjs",
    "scripts/verify-email-production.test.mjs",
    "scripts/migrate-production-origin.test.mjs",
    "scripts/migrate-topology-databases.test.mjs",
    "scripts/migrate-workspace.test.mjs",
    "scripts/r2-conditional-create.test.mjs",
    "scripts/development-entrypoints.test.mjs",
    "scripts/migrate-development.test.mjs",
    "scripts/configure-local-oauth.test.mjs",
    "scripts/test-local-oauth.test.mjs",
    "scripts/production-smoke.test.mjs",
    "scripts/production-topology-safety.test.mjs",
    "scripts/release-tags.test.mjs",
    "scripts/rollback.test.mjs",
    "scripts/topology-manifest.test.mjs",
    "scripts/topology-deployment.test.mjs",
    "scripts/datafn-ticket-keys.test.mjs",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (localRuntimeTests.status !== 0) {
  process.exit(localRuntimeTests.status ?? 1);
}

const result = spawnSync("pnpm", ["exec", "turbo", "run", "test:unit", ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(result.status ?? 1);
