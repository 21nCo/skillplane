#!/usr/bin/env node
import { mkdir, copyFile, chmod, lstat } from "node:fs/promises";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const bin = resolve(process.argv[2] ?? join(homedir(), ".local/bin"));
const destination = join(bin, "skillplane");
try {
  await lstat(destination);
  throw new Error(
    "Destination already exists; choose an empty installation directory to preserve the existing executable",
  );
} catch (e) {
  if (e.code !== "ENOENT") throw e;
}
await mkdir(bin, { recursive: true });
await copyFile(
  join(repo, "packages/local-runtime/dist/skillplane.mjs"),
  destination,
  1,
);
await chmod(destination, 0o755);
console.log(
  `Installed ${destination}. Add ${bin} to PATH, then run skillplane init --target codex (or claude). Local setup needs no cloud account.`,
);
