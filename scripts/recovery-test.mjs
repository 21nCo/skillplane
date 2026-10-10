#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

for (const [command, arguments_] of [
  ["pnpm", ["--filter", "@skillplane/db...", "build"]],
  ["pnpm", ["--filter", "@skillplane/storage", "build"]],
  ["pnpm", ["--filter", "@skillplane/testing", "build"]],
]) {
  const result = spawnSync(command, arguments_, {
    cwd: root,
    stdio: "inherit",
  });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const result = spawnSync(
  process.execPath,
  [resolve(root, "tests/recovery/recovery-rehearsal.mjs")],
  {
    cwd: root,
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
