#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { R2BundleRepository } from "../packages/storage/dist/src/index.js";
import { parseArguments } from "./lib/local-database.mjs";

class RehearsalBucket {
  objects = new Map();
  failListing = false;

  seed(key, uploaded = new Date(0)) {
    this.objects.set(key, {
      key,
      uploaded,
      size: 1,
      etag: `etag-${this.objects.size + 1}`,
      bytes: new Uint8Array([1]),
      customMetadata: {},
    });
  }

  async list() {
    if (this.failListing) throw new Error("injected inventory failure");
    return {
      objects: [...this.objects.values()].map((value) => ({
        key: value.key,
        uploaded: value.uploaded,
        size: value.size,
        etag: value.etag,
        customMetadata: value.customMetadata,
      })),
      truncated: false,
    };
  }

  async delete(keys) {
    for (const key of typeof keys === "string" ? [keys] : keys) {
      this.objects.delete(key);
    }
  }

  async head(key) {
    return this.objects.get(key) ?? null;
  }

  async get(key) {
    const value = this.objects.get(key);
    if (!value) return null;
    return {
      ...value,
      arrayBuffer: async () => value.bytes.slice().buffer,
    };
  }

  async put(key, bytes) {
    this.seed(key, new Date());
    const value = this.objects.get(key);
    value.bytes = bytes.slice();
    value.size = bytes.byteLength;
    return value;
  }
}

const arguments_ = parseArguments(process.argv.slice(2));
const manifestPath = arguments_.value("manifest");
let referencedKey =
  "workspaces/recovery/skills/skill/bundles/sha256/" + "a".repeat(64) + ".zip";
if (manifestPath) {
  const manifest = JSON.parse(await readFile(resolve(manifestPath), "utf8"));
  const candidate = manifest?.r2?.bundleReferences?.[0]?.objectKey;
  if (typeof candidate === "string") referencedKey = candidate;
}
const orphanKey =
  "workspaces/recovery/skills/orphan/bundles/sha256/" + "b".repeat(64) + ".zip";
const preservedOnFailureKey =
  "workspaces/recovery/skills/failure/bundles/sha256/" + "c".repeat(64) + ".zip";
const bucket = new RehearsalBucket();
bucket.seed(referencedKey);
bucket.seed(orphanKey);
const repository = new R2BundleRepository(bucket);
const cleanup = await repository.cleanupOrphans({
  olderThan: new Date(),
  referencedKeys: async () => new Set([referencedKey]),
});
if (
  cleanup.deleted.length !== 1 ||
  cleanup.deleted[0] !== orphanKey ||
  !bucket.objects.has(referencedKey)
) {
  throw new Error("Orphan cleanup did not preserve the referenced bundle");
}

bucket.seed(preservedOnFailureKey);
bucket.failListing = true;
await repository
  .cleanupOrphans({
    olderThan: new Date(),
    referencedKeys: async () => new Set([referencedKey]),
  })
  .then(() => {
    throw new Error("Inventory failure was expected to fail closed");
  })
  .catch((error) => {
    if (error?.code !== "R2_CLEANUP_FAILED") throw error;
  });
bucket.failListing = false;
if (!bucket.objects.has(preservedOnFailureKey)) {
  throw new Error("Listing failure deleted an object");
}

await repository
  .cleanupOrphans({
    olderThan: new Date(),
    referencedKeys: async () => {
      throw new Error("injected reference failure");
    },
  })
  .then(() => {
    throw new Error("Reference failure was expected to fail closed");
  })
  .catch((error) => {
    if (error?.code !== "R2_CLEANUP_FAILED") throw error;
  });
if (!bucket.objects.has(preservedOnFailureKey)) {
  throw new Error("Reference inventory failure deleted an object");
}

process.stdout.write(
  `${JSON.stringify(
    {
      ok: true,
      mode: "local-rehearsal",
      scanned: cleanup.scanned,
      deleted: cleanup.deleted,
      preserved: [...bucket.objects.keys()].sort(),
      failClosed: {
        listingFailure: true,
        referenceFailure: true,
      },
    },
    null,
    2,
  )}\n`,
);
