#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { authFnApiKeyPlugin } = await load("@authfn/api-keys");
const { authFnEmailOtpPlugin } = await load("@authfn/email-otp");
const { authFnMultiRegionPlugin } = await load("@authfn/multi-region");
const { getSchema } = await load("authfn");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

const schema = getSchema({
  namespace: "authfn",
  plugins: [authFnEmailOtpPlugin(), authFnApiKeyPlugin(), authFnMultiRegionPlugin()],
});
const actual = createHash("sha256")
  .update(JSON.stringify(stable(schema)))
  .digest("hex");
const lock = JSON.parse(
  await readFile(
    new URL("../.conduct/authfn-schema.lock.json", import.meta.url),
    "utf8",
  ),
);

if (actual !== lock.sha256 || schema.version !== lock.schemaVersion) {
  throw new Error(
    `AuthFn generated schema drifted (expected ${lock.sha256}, received ${actual})`,
  );
}
console.log(`AuthFn schema ${schema.version} matches ${actual}`);
