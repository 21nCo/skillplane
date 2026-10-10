#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsAfterScript = process.argv.slice(2);
const filters = argumentsAfterScript.flatMap((argument, index) =>
  argument === "--filter" && argumentsAfterScript[index + 1]
    ? [argumentsAfterScript[index + 1]]
    : [],
);

if (filters.includes("auth-otp")) {
  if (filters.length !== 1) {
    process.stderr.write(
      'The logical "auth-otp" suite cannot be combined with package filters.\n',
    );
    process.exit(2);
  }
  for (const packageName of ["@skillplane/email", "@skillplane/auth"]) {
    const result = spawnSync("pnpm", ["--filter", packageName, "test:integration"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
  process.exit(0);
}

if (filters.includes("tenancy")) {
  if (filters.length !== 1) {
    process.stderr.write(
      'The logical "tenancy" suite cannot be combined with package filters.\n',
    );
    process.exit(2);
  }
  const result = spawnSync(
    "pnpm",
    ["--filter", "@skillplane/api", "test:integration"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"]
          .filter(Boolean)
          .join(" "),
      },
    },
  );
  process.exit(result.status ?? 1);
}

const focusedIntegrationSuites = new Map([
  [
    "skill-storage",
    ["@skillplane/api", "tests/integration/skill-storage.integration.test.ts"],
  ],
  [
    "publication-concurrency",
    [
      "@skillplane/api",
      "tests/integration/publication-concurrency.integration.test.ts",
    ],
  ],
  ["skill-api", ["@skillplane/api", "tests/integration/skill-api.integration.test.ts"]],
  ["contexts", ["@skillplane/api", "tests/integration/contexts.integration.test.ts"]],
  [
    "amendments",
    ["@skillplane/api", "tests/integration/amendments.integration.test.ts"],
  ],
  ["oauth", ["@skillplane/api", "tests/integration/oauth.integration.test.ts"]],
  ["mcp-read", ["@skillplane/mcp", "tests/integration/mcp-read.integration.test.ts"]],
  [
    "mcp-mutations",
    ["@skillplane/mcp", "tests/integration/mcp-mutations.integration.test.ts"],
  ],
  [
    "audit-analytics",
    ["@skillplane/api", "tests/integration/audit-analytics.integration.test.ts"],
  ],
  [
    "public-skills",
    ["@skillplane/api", "tests/integration/public-skills.integration.test.ts"],
  ],
]);
const focusedSuite =
  filters.length === 1 ? focusedIntegrationSuites.get(filters[0]) : undefined;
if (focusedSuite) {
  const [packageName, testFile] = focusedSuite;
  const build = spawnSync("pnpm", ["--filter", `${packageName}...`, "build"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (build.status !== 0) process.exit(build.status ?? 1);
  const result = spawnSync(
    "pnpm",
    [
      "--filter",
      packageName,
      "exec",
      "vitest",
      "run",
      "--exclude",
      "dist/**",
      testFile,
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"]
          .filter(Boolean)
          .join(" "),
      },
    },
  );
  process.exit(result.status ?? 1);
}

const result = spawnSync(
  "pnpm",
  ["exec", "turbo", "run", "test:integration", ...argumentsAfterScript],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
