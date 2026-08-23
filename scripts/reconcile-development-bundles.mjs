#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import {
  developmentBucket,
  developmentCloudflareEnvironment,
  developmentDatabase,
} from "./lib/development-deployment.mjs";
import {
  isMain,
  productionBucket,
  requireEnvironment,
} from "./lib/production-deployment.mjs";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function md5(bytes) {
  return createHash("md5").update(bytes).digest("hex");
}

function sourceCloudflareEnvironment() {
  const environment = { ...process.env };
  for (const name of [
    "SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN",
    "SKILLPLANE_DEV_AUTHFN_SECRET",
    "SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER",
    "SKILLPLANE_DEV_TURNSTILE_SECRET_KEY",
    "SKILLPLANE_DEV_DATABASE_URL",
  ]) {
    Reflect.deleteProperty(environment, name);
  }
  return environment;
}

function wranglerObjectGet(bucket, key, path, environment) {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "wrangler",
      "r2",
      "object",
      "get",
      `${bucket}/${key}`,
      "--remote",
      "--file",
      path,
    ],
    {
      env: environment,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 16 * 1024 * 1024,
    },
  );
  if (result.error) throw result.error;
  if (result.status === 0) return true;
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (/not found|does not exist|404/iu.test(output)) return false;
  throw new Error(`Could not read an object from ${bucket}`);
}

function cloudflareAccountId(environment) {
  const result = spawnSync("pnpm", ["exec", "wrangler", "whoami"], {
    env: environment,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error("Could not resolve the development Cloudflare account");
  }
  const ids = [...result.stdout.matchAll(/\b[a-f0-9]{32}\b/giu)].map((match) =>
    match[0].toLowerCase(),
  );
  const unique = [...new Set(ids)];
  if (unique.length !== 1) {
    throw new Error("Development Cloudflare account identity is ambiguous");
  }
  return unique[0];
}

function cloudflareObjectUrl(accountId, bucket, key = "") {
  const base = `https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(bucket)}/objects`;
  return key ? `${base}/${key}` : base;
}

async function cloudflareObjects(bucket, environment, accountId) {
  const objects = [];
  let cursor;
  do {
    const url = new URL(cloudflareObjectUrl(accountId, bucket));
    if (cursor) url.searchParams.set("cursor", cursor);
    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}` },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`Could not inventory ${bucket}`);
    const body = await response.json();
    if (body?.success !== true || !Array.isArray(body.result)) {
      throw new Error(`Cloudflare returned an invalid inventory for ${bucket}`);
    }
    objects.push(...body.result);
    cursor = body.result_info?.is_truncated ? body.result_info?.cursor : undefined;
    if (body.result_info?.is_truncated && !cursor) {
      throw new Error(`Cloudflare omitted the inventory cursor for ${bucket}`);
    }
  } while (cursor);
  const inventory = new Map(objects.map((object) => [object.key, object]));
  if (inventory.size !== objects.length) {
    throw new Error(`${bucket} contains duplicate object keys`);
  }
  return inventory;
}

async function cloudflareObjectPut(bucket, key, bytes, environment, accountId) {
  const response = await fetch(cloudflareObjectUrl(accountId, bucket, key), {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${environment.CLOUDFLARE_API_TOKEN}`,
      "Cache-Control": "public, max-age=31536000, immutable",
      "Content-Type": "application/zip",
    },
    body: bytes,
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`Could not write an object to ${bucket}`);
  const body = await response.json();
  if (body?.success !== true || !body.result) {
    throw new Error(`Cloudflare did not confirm the object written to ${bucket}`);
  }
  return body.result;
}

async function referencedBundles(database) {
  const pool = new Pool({
    connectionString: database.url,
    application_name: "skillplane-development-r2-reconciliation",
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const result = await pool.query(
      `SELECT DISTINCT r2_object_key AS object_key,
              content_digest AS digest,
              bundle_byte_size::text AS byte_size
         FROM skill_versions
        ORDER BY r2_object_key`,
    );
    return result.rows.map((row) => ({
      key: row.object_key,
      digest: row.digest,
      byteSize: Number(row.byte_size),
    }));
  } finally {
    await pool.end();
  }
}

function validateReference(reference) {
  if (
    typeof reference.key !== "string" ||
    !/^workspaces\/[^/]+\/skills\/[^/]+\/bundles\/sha256\/[a-f0-9]{64}\.zip$/u.test(
      reference.key,
    ) ||
    !/^sha256:[a-f0-9]{64}$/u.test(reference.digest) ||
    !Number.isSafeInteger(reference.byteSize) ||
    reference.byteSize < 1 ||
    reference.byteSize > 10 * 1024 * 1024
  ) {
    throw new Error("The development database contains an invalid bundle reference");
  }
}

async function verifyObject(path, reference, label) {
  const bytes = await readFile(path);
  if (
    bytes.byteLength !== reference.byteSize ||
    `sha256:${sha256(bytes)}` !== reference.digest
  ) {
    throw new Error(`${label} bundle does not match the development database`);
  }
  return bytes.byteLength;
}

function verifyInventoryObject(object, reference, expectedEtag) {
  const etag = String(object?.etag ?? "").replaceAll('"', "");
  if (
    object?.key !== reference.key ||
    Number(object?.size) !== reference.byteSize ||
    etag !== expectedEtag
  ) {
    throw new Error(
      "A development R2 object does not match its verified production bundle",
    );
  }
}

export async function reconcileDevelopmentBundles(options = {}) {
  requireEnvironment("SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN", {
    minimumLength: 20,
    trim: false,
  });
  const references =
    options.references ?? (await referencedBundles(developmentDatabase()));
  const getSourceObject = options.getSourceObject ?? wranglerObjectGet;
  const putTargetObject = options.putTargetObject ?? cloudflareObjectPut;
  const sourceEnvironment = options.sourceEnvironment ?? sourceCloudflareEnvironment();
  const targetEnvironment =
    options.targetEnvironment ?? developmentCloudflareEnvironment();
  const targetAccountId =
    options.targetAccountId ?? cloudflareAccountId(targetEnvironment);
  const inventory =
    options.inventory ??
    (await cloudflareObjects(developmentBucket, targetEnvironment, targetAccountId));
  const directory = await mkdtemp(join(tmpdir(), "skillplane-dev-r2-"));
  let copied = 0;
  let existing = 0;
  let verifiedBytes = 0;
  const expectedEtags = new Map();
  try {
    for (const [index, reference] of references.entries()) {
      validateReference(reference);
      const sourcePath = join(directory, `${index}-source.zip`);
      const sourceExists = await getSourceObject(
        productionBucket,
        reference.key,
        sourcePath,
        sourceEnvironment,
      );
      if (!sourceExists) {
        throw new Error("A database-referenced production bundle is missing");
      }
      await verifyObject(sourcePath, reference, "Production");
      const sourceBytes = await readFile(sourcePath);
      const expectedEtag = md5(sourceBytes);
      expectedEtags.set(reference.key, expectedEtag);
      const current = inventory.get(reference.key);
      if (current) {
        verifyInventoryObject(current, reference, expectedEtag);
        existing += 1;
      } else {
        const created = await putTargetObject(
          developmentBucket,
          reference.key,
          sourceBytes,
          targetEnvironment,
          targetAccountId,
        );
        verifyInventoryObject(created, reference, expectedEtag);
        inventory.set(reference.key, created);
        copied += 1;
      }
      verifiedBytes += sourceBytes.byteLength;
      await unlink(sourcePath);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  const finalInventory = await cloudflareObjects(
    developmentBucket,
    targetEnvironment,
    targetAccountId,
  );
  for (const reference of references) {
    verifyInventoryObject(
      finalInventory.get(reference.key),
      reference,
      expectedEtags.get(reference.key),
    );
  }
  return {
    ok: true,
    sourceBucket: productionBucket,
    targetBucket: developmentBucket,
    referenced: references.length,
    copied,
    existing,
    verifiedBytes,
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await reconcileDevelopmentBundles(), null, 2)}\n`,
  );
}
