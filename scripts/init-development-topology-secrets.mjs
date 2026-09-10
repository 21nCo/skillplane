#!/usr/bin/env node

import { randomBytes, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  isMain,
  pathExists,
  portablePath,
  root,
} from "./lib/production-deployment.mjs";

const secretNames = Object.freeze([
  "SKILLPLANE_DEV_WORKSPACE_ROUTING_SECRET",
  "SKILLPLANE_DEV_BACKUP_ENCRYPTION_KEY",
]);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function assignments(source, name) {
  const expression = new RegExp(`^(?:export\\s+)?${name}=(.*)$`, "gmu");
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function validateSecret(name, value) {
  if (value.length < 32 || new Set(value).size < 10) {
    throw new Error(`${name} is not strong enough`);
  }
}

export async function initializeDevelopmentTopologySecrets(options = {}) {
  const path = resolve(options.path ?? root, ".env.development.local");
  if (await pathExists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(".env.development.local must be a regular file");
    }
  }
  let source = (await pathExists(path)) ? await readFile(path, "utf8") : "";
  const generated = [];
  const retained = [];
  const values = [];
  for (const [name, value] of Object.entries(options.resources ?? {})) {
    if (!value) continue;
    const matches = assignments(source, name);
    if (matches.length > 1) throw new Error(`${name} is assigned more than once`);
    if (matches.length === 1) {
      if (matches[0] !== value) throw new Error(`${name} does not match the resource`);
      retained.push(name);
      continue;
    }
    source = `${source.trimEnd()}${source.trim() ? "\n" : ""}${name}=${value}\n`;
    generated.push(name);
  }
  for (const name of secretNames) {
    const matches = assignments(source, name);
    if (matches.length > 1) throw new Error(`${name} is assigned more than once`);
    if (matches.length === 1) {
      validateSecret(name, matches[0]);
      retained.push(name);
      values.push(matches[0]);
      continue;
    }
    const value = randomBytes(48).toString("base64url");
    source = `${source.trimEnd()}${source.trim() ? "\n" : ""}${name}=${value}\n`;
    generated.push(name);
    values.push(value);
  }
  if (new Set(values).size !== values.length) {
    throw new Error("Development topology secrets must be independent");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, source, { flag: "wx", mode: 0o600 });
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
  return {
    ok: true,
    path: portablePath(path),
    generated,
    retained,
    valuesPrinted: false,
    mode: "0600",
  };
}

if (isMain(import.meta.url)) {
  const result = await initializeDevelopmentTopologySecrets({
    ...(argument("--directory") ? { path: argument("--directory") } : {}),
    resources: {
      CLOUDFLARE_DEV_CONTROL_HYPERDRIVE_ID: argument("--control-hyperdrive-id"),
      CLOUDFLARE_DEV_CELL_IN_SOUTH_HYPERDRIVE_ID: argument("--in-south-hyperdrive-id"),
      CLOUDFLARE_DEV_CELL_US_EAST_HYPERDRIVE_ID: argument("--us-east-hyperdrive-id"),
      CLOUDFLARE_DEV_CELL_EU_WEST_HYPERDRIVE_ID: argument("--eu-west-hyperdrive-id"),
    },
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
