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
  "AUTHFN_SECRET",
  "OAUTH_TOKEN_PEPPER",
  "SKILLPLANE_BACKUP_ENCRYPTION_KEY",
]);

function assignments(source, name) {
  const expression = new RegExp(`^(?:export\\s+)?${name}=(.*)$`, "gmu");
  return [...source.matchAll(expression)].map((match) => match[1]);
}

function validateExistingSecret(name, value) {
  if (
    value.length < 32 ||
    new Set(value).size < 10 ||
    /(?:change[-_ ]?me|placeholder|not[-_ ]?for[-_ ]?production)/iu.test(value)
  ) {
    throw new Error(`${name} in .env.production.local is not production quality`);
  }
}

export async function initializeProductionSecrets() {
  const path = resolve(root, ".env.production.local");
  if (await pathExists(path)) {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(".env.production.local must be a regular file");
    }
  }
  let source = (await pathExists(path)) ? await readFile(path, "utf8") : "";
  const generated = [];
  const retained = [];
  const values = [];
  for (const name of secretNames) {
    const matches = assignments(source, name);
    if (matches.length > 1) {
      throw new Error(`${name} is assigned more than once`);
    }
    if (matches.length === 1) {
      validateExistingSecret(name, matches[0]);
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
    throw new Error("Production secrets must be independent values");
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
  process.stdout.write(
    `${JSON.stringify(await initializeProductionSecrets(), null, 2)}\n`,
  );
}
