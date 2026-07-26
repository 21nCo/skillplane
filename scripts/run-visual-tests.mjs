#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const filters = args.flatMap((argument, index) =>
  argument === "--filter" && args[index + 1] ? [args[index + 1]] : [],
);

if (filters.length === 1 && filters[0] === "landing") {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      "landing.visual.spec.ts",
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

if (filters.length === 1 && filters[0] === "skill-pages") {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      "skill-pages.visual.spec.ts",
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

if (filters.length === 1 && filters[0] === "amendment-review") {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      "--grep",
      "@amendment-review",
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

if (filters.length === 1 && filters[0] === "analytics-audit") {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "--config",
      "packages/testing/playwright.config.ts",
      "analytics-audit.visual.spec.ts",
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

const result = spawnSync("pnpm", ["exec", "turbo", "run", "test:visual", ...args], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
});
process.exit(result.status ?? 1);
