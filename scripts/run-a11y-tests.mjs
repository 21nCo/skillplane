#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const filters = args.flatMap((argument, index) =>
  argument === "--filter" && args[index + 1] ? [args[index + 1]] : [],
);

const focusedSpecs = new Map([
  ["skill-pages", "skill-pages.a11y.spec.ts"],
  ["context-pages", "context-pages.a11y.spec.ts"],
]);
const focusedSpec = filters.length === 1 ? focusedSpecs.get(filters[0]) : undefined;

if (focusedSpec) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      focusedSpec,
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

if (filters.length > 0) {
  process.stderr.write(
    `Unknown accessibility suite "${filters.join(", ")}". Available suites: context-pages, skill-pages\n`,
  );
  process.exit(2);
}

const contract = spawnSync(
  "pnpm",
  ["exec", "vitest", "run", "tests/accessibility/matrix-contract.test.ts"],
  {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
  },
);
if (contract.status !== 0) process.exit(contract.status ?? 1);

const workbench = spawnSync("pnpm", ["--filter", "@skillplane/ui", "test:a11y"], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (workbench.status !== 0) process.exit(workbench.status ?? 1);

for (const spec of focusedSpecs.values()) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      spec,
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
  if (result.status !== 0) process.exit(result.status ?? 1);
}
