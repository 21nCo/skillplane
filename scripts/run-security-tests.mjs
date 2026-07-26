#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argumentsAfterScript = process.argv.slice(2);
const filterIndex = argumentsAfterScript.indexOf("--filter");
const filter = filterIndex >= 0 ? argumentsAfterScript[filterIndex + 1] : undefined;

const focusedSecuritySuites = new Map([
  ["bundle", ["@skillplane/storage", "tests/security/bundle.security.test.ts"]],
  [
    "tenant-search",
    ["@skillplane/api", "tests/security/tenant-search.security.test.ts"],
  ],
  [
    "context-isolation",
    ["@skillplane/api", "tests/security/context-isolation.security.test.ts"],
  ],
  [
    "amendment-policy",
    ["@skillplane/api", "tests/security/amendment-policy.security.test.ts"],
  ],
  ["oauth", ["@skillplane/api", "tests/security/oauth.security.test.ts"]],
  ["mcp-read", ["@skillplane/mcp", "tests/security/mcp-read.security.test.ts"]],
  [
    "mcp-mutations",
    ["@skillplane/mcp", "tests/security/mcp-mutations.security.test.ts"],
  ],
  ["redaction", ["@skillplane/api", "tests/security/redaction.security.test.ts"]],
  [
    "public-visibility",
    ["@skillplane/api", "tests/security/public-visibility.security.test.ts"],
  ],
]);

if (
  filter &&
  !["tenancy", "tenant-foundation", "auth", ...focusedSecuritySuites.keys()].includes(
    filter,
  )
) {
  process.stderr.write(
    `Unknown security suite "${filter}". Available suites: amendment-policy, auth, bundle, context-isolation, mcp-mutations, mcp-read, oauth, public-visibility, redaction, tenancy, tenant-foundation, tenant-search\n`,
  );
  process.exit(2);
}

const focusedSuite = filter ? focusedSecuritySuites.get(filter) : undefined;
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

if (!filter) {
  const reset = spawnSync(
    "pnpm",
    ["--filter", "@skillplane/testing", "db:reset:test"],
    {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: "inherit",
    },
  );
  if (reset.status !== 0) process.exit(reset.status ?? 1);
}

const packages =
  filter === "auth"
    ? ["@skillplane/email", "@skillplane/auth"]
    : filter === "tenant-foundation" || filter === "tenancy"
      ? ["@skillplane/datafn", "@skillplane/api"]
      : [
          "@skillplane/email",
          "@skillplane/auth",
          "@skillplane/datafn",
          "@skillplane/api",
          "@skillplane/storage",
          "@skillplane/mcp",
        ];

for (const packageName of packages) {
  const result = spawnSync("pnpm", ["--filter", packageName, "test:security"], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (!filter) {
  const releaseBoundary = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--exclude",
      "dist/**",
      "tests/security/release-boundary.security.test.ts",
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
  if (releaseBoundary.status !== 0) {
    process.exit(releaseBoundary.status ?? 1);
  }
}
