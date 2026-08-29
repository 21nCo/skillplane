#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function pnpmInvocation() {
  if (process.platform !== "win32") {
    return { executable: "pnpm", prefixArguments: [] };
  }
  const scriptPath = process.env.npm_execpath;
  if (!scriptPath || !isAbsolute(scriptPath) || !/\.[cm]?js$/u.test(scriptPath)) {
    throw new Error(
      "Windows MCP tests must run through a pnpm lifecycle with an absolute JavaScript npm_execpath",
    );
  }
  return { executable: process.execPath, prefixArguments: [scriptPath] };
}

const pnpm = pnpmInvocation();

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
  run(pnpm.executable, [
    ...pnpm.prefixArguments,
    "--filter",
    "@skillplane/mcp...",
    "build",
  ]);
  run(
    pnpm.executable,
    [
      ...pnpm.prefixArguments,
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
