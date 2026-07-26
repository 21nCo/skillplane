#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const workspaceAliases = new Map([
  ["app", "@skillplane/app"],
  ["landing", "@skillplane/landing"],
  ["mcp", "@skillplane/mcp"],
]);
const input = process.argv.slice(2);
const argumentsForTurbo = [];

for (let index = 0; index < input.length; index += 1) {
  const argument = input[index];
  if (argument === "--filter") {
    const value = input[index + 1];
    if (!value) {
      process.stderr.write("--filter requires a workspace name\n");
      process.exit(2);
    }
    argumentsForTurbo.push("--filter", workspaceAliases.get(value) ?? value);
    index += 1;
  } else if (argument?.startsWith("--filter=")) {
    const value = argument.slice("--filter=".length);
    argumentsForTurbo.push(`--filter=${workspaceAliases.get(value) ?? value}`);
  } else if (argument) {
    argumentsForTurbo.push(argument);
  }
}

const result = spawnSync(
  "pnpm",
  ["exec", "turbo", "run", "build", ...argumentsForTurbo],
  {
    stdio: "inherit",
  },
);
process.exit(result.status ?? 1);
