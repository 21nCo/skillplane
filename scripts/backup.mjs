#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { access, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import {
  databaseInventory,
  localDatabaseIdentity,
  parseArguments,
  requireContainerName,
  resolveLocalDatabaseUrl,
  root,
  sha256,
} from "./lib/local-database.mjs";

const arguments_ = parseArguments(process.argv.slice(2));
const databaseUrl = await resolveLocalDatabaseUrl(arguments_.value("database-url"));
const identity = localDatabaseIdentity(databaseUrl);
const output = resolve(
  arguments_.value("output") ??
    resolve(
      root,
      ".data",
      "backups",
      `skillplane-${new Date().toISOString().replaceAll(/[:.]/gu, "-")}.dump`,
    ),
);
const manifestPath = resolve(arguments_.value("manifest") ?? `${output}.manifest.json`);
const overwrite = arguments_.has("overwrite");
const portablePath = (path) => relative(root, path).split(sep).join("/") || ".";

if (!overwrite) {
  for (const path of [output, manifestPath]) {
    await access(path)
      .then(() => {
        throw new Error(`Refusing to overwrite existing backup artifact: ${path}`);
      })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
  }
}

const inventory = await databaseInventory(databaseUrl);
const dump = execFileSync(
  "docker",
  [
    "exec",
    requireContainerName(arguments_.value("container")),
    "pg_dump",
    "--username",
    identity.username,
    "--dbname",
    identity.database,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
  ],
  { maxBuffer: 1024 * 1024 * 1024 },
);
if (dump.byteLength === 0) throw new Error("pg_dump produced an empty backup");

await mkdir(resolve(output, ".."), { recursive: true, mode: 0o700 });
await mkdir(resolve(manifestPath, ".."), { recursive: true, mode: 0o700 });
const nonce = crypto.randomUUID();
const temporaryDump = `${output}.${nonce}.tmp`;
const temporaryManifest = `${manifestPath}.${nonce}.tmp`;
const manifest = {
  formatVersion: 1,
  createdAt: new Date().toISOString(),
  source: {
    host: identity.host,
    port: identity.port,
    database: identity.database,
  },
  dump: {
    sha256: sha256(dump),
    byteSize: dump.byteLength,
    format: "postgres-custom",
  },
  migrations: inventory.migrations,
  r2: {
    bundleReferenceCount: inventory.bundleReferences.length,
    bundleReferenceDigest: inventory.bundleReferenceDigest,
    bundleReferences: inventory.bundleReferences,
  },
};

try {
  await writeFile(temporaryDump, dump, { flag: "wx", mode: 0o600 });
  await writeFile(temporaryManifest, `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  if (overwrite) {
    await Promise.all([
      unlink(output).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
      unlink(manifestPath).catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      }),
    ]);
  }
  await rename(temporaryDump, output);
  await rename(temporaryManifest, manifestPath);
} catch (error) {
  await Promise.all([
    unlink(temporaryDump).catch(() => undefined),
    unlink(temporaryManifest).catch(() => undefined),
  ]);
  throw error;
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      output: portablePath(output),
      manifest: portablePath(manifestPath),
      byteSize: dump.byteLength,
      sha256: manifest.dump.sha256,
      migrations: manifest.migrations.length,
      bundleReferences: manifest.r2.bundleReferenceCount,
    },
    null,
    2,
  )}\n`,
);
