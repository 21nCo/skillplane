#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const verify = spawnSync("node", ["scripts/verify-mcpfn-adoption.mjs"], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (verify.status !== 0) process.exit(verify.status ?? 1);
const build = spawnSync("pnpm", ["--filter", "@skillplane/mcp...", "build"], {
  cwd: repoRoot,
  encoding: "utf8",
  stdio: "inherit",
});
if (build.status !== 0) process.exit(build.status ?? 1);

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@skillplane/mcp",
    "exec",
    "vitest",
    "run",
    "--exclude",
    "dist/**",
    "tests/conformance/mcp.conformance.test.ts",
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
