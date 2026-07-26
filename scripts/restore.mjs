#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { verifyDatabase } from "../packages/db/dist/src/index.js";
import {
  databaseInventory,
  dropDisposableDatabase,
  localDatabaseIdentity,
  parseArguments,
  recreateDisposableDatabase,
  requireContainerName,
  resolveLocalDatabaseUrl,
  sha256,
} from "./lib/local-database.mjs";

const arguments_ = parseArguments(process.argv.slice(2));
const inputValue = arguments_.value("input");
const targetValue = arguments_.value("database-url");
if (!inputValue || !targetValue) {
  throw new Error(
    "Usage: restore.mjs --input <dump> --database-url <local *_test URL> [--manifest <path>]",
  );
}
const input = resolve(inputValue);
const manifestPath = resolve(arguments_.value("manifest") ?? `${input}.manifest.json`);
const targetUrl = await resolveLocalDatabaseUrl(targetValue);
const identity = localDatabaseIdentity(targetUrl);
const dump = await readFile(input);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (
  manifest?.formatVersion !== 1 ||
  manifest?.dump?.format !== "postgres-custom" ||
  typeof manifest?.dump?.sha256 !== "string" ||
  !Array.isArray(manifest?.migrations) ||
  !Array.isArray(manifest?.r2?.bundleReferences)
) {
  throw new Error("Backup manifest is invalid or unsupported");
}
if (sha256(dump) !== manifest.dump.sha256) {
  throw new Error("Backup checksum does not match the manifest");
}

let restored = false;
await recreateDisposableDatabase(targetUrl);
try {
  execFileSync(
    "docker",
    [
      "exec",
      "--interactive",
      requireContainerName(arguments_.value("container")),
      "pg_restore",
      "--username",
      identity.username,
      "--dbname",
      identity.database,
      "--no-owner",
      "--no-privileges",
      "--exit-on-error",
    ],
    {
      input: dump,
      maxBuffer: 1024 * 1024 * 1024,
      stdio: ["pipe", "inherit", "inherit"],
    },
  );
  const verification = await verifyDatabase(targetUrl);
  const inventory = await databaseInventory(targetUrl);
  const migrationDigest = JSON.stringify(inventory.migrations);
  const expectedMigrationDigest = JSON.stringify(manifest.migrations);
  if (migrationDigest !== expectedMigrationDigest) {
    throw new Error("Restored migration ledger does not match the backup manifest");
  }
  if (
    inventory.bundleReferences.length !== manifest.r2.bundleReferenceCount ||
    inventory.bundleReferenceDigest !== manifest.r2.bundleReferenceDigest
  ) {
    throw new Error("Restored R2 reference inventory does not match the backup");
  }
  restored = true;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        database: identity.database,
        migrations: verification.migrations.length,
        tables: verification.tables.length,
        bundleReferences: inventory.bundleReferences.length,
        bundleReferenceDigest: inventory.bundleReferenceDigest,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (!restored) await dropDisposableDatabase(targetUrl).catch(() => undefined);
}
