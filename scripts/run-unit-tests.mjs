#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const filters = args.flatMap((argument, index) =>
  argument === "--filter" && args[index + 1] ? [args[index + 1]] : [],
);
const positional = args.slice(Math.max(0, args.indexOf("--") + 1));

const localRuntimeTests = spawnSync(
  process.execPath,
  [
    "--test",
    "scripts/lib/local-postgres-port.test.mjs",
    "scripts/lib/local-wrangler-config.test.mjs",
    "scripts/lib/local-worker-vars.test.mjs",
    "scripts/local-init.test.mjs",
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

if (filters.length === 1 && filters[0] === "landing") {
  const result = spawnSync("pnpm", ["--filter", "@skillplane/landing", "test:unit"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  process.exit(result.status ?? 1);
}

if (filters.length === 1 && filters[0] === "app" && positional.includes("skills")) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@skillplane/app",
      "exec",
      "vitest",
      "run",
      "tests/unit/skills.test.ts",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (
  filters.length === 1 &&
  filters[0] === "@skillplane/domain" &&
  positional.some((name) =>
    ["amendments", "learning-metadata", "policies"].includes(name),
  )
) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@skillplane/domain",
      "exec",
      "vitest",
      "run",
      "src/amendments.test.ts",
      "src/learning-metadata.test.ts",
      "src/amendment-policy.test.ts",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (
  filters.length === 1 &&
  filters[0] === "@skillplane/domain" &&
  positional.includes("contexts")
) {
  const result = spawnSync(
    "pnpm",
    ["--filter", "@skillplane/domain", "exec", "vitest", "run", "src/contexts.test.ts"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

if (
  filters.length === 1 &&
  filters[0] === "@skillplane/mcp-schema" &&
  positional.some((name) => ["amend", "contexts", "schemas"].includes(name))
) {
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      "@skillplane/mcp-schema",
      "exec",
      "vitest",
      "run",
      "src/schema.test.ts",
      "src/mutation-schema.test.ts",
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  process.exit(result.status ?? 1);
}

const result = spawnSync("pnpm", ["exec", "turbo", "run", "test:unit", ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(result.status ?? 1);
