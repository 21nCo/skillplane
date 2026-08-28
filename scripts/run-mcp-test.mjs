#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const corepackExecutable = resolve(
  dirname(process.execPath),
  process.platform === "win32" ? "corepack.cmd" : "corepack",
);

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: "inherit",
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function runMcpTest(testFile) {
  run(process.execPath, ["scripts/verify-mcpfn-adoption.mjs"]);
  run(corepackExecutable, ["pnpm", "--filter", "@skillplane/mcp...", "build"]);
  run(
    corepackExecutable,
    [
      "pnpm",
      "--filter",
      "@skillplane/mcp",
      "exec",
      "vitest",
      "run",
      "--exclude",
      "dist/**",
      testFile,
    ],
    {
      env: {
        ...process.env,
        NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"]
          .filter(Boolean)
          .join(" "),
      },
    },
  );
}
