#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";

const require = createRequire(new URL("../packages/db/package.json", import.meta.url));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { getSchema } = await load("authfn");
const { skillplaneAuthPlugins } =
  await import("../packages/auth/src/plugin-composition.ts");
const { createOAuthSchema } =
  await import("../packages/authfn-mcp-oauth/src/schema.ts");

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

const plugins = skillplaneAuthPlugins({
  name: "skillplaneMcpOAuth",
  schema: () => createOAuthSchema(),
});
const schema = getSchema({ namespace: "authfn", plugins });
const actual = createHash("sha256")
  .update(JSON.stringify(stable(schema)))
  .digest("hex");
const lock = JSON.parse(
  await readFile(
    new URL("../.conduct/authfn-schema.lock.json", import.meta.url),
    "utf8",
  ),
);

const pluginNames = plugins.map((plugin) => plugin.name);
if (
  actual !== lock.sha256 ||
  schema.version !== lock.schemaVersion ||
  JSON.stringify(pluginNames) !== JSON.stringify(lock.pluginNames)
) {
  throw new Error(
    `AuthFn generated schema drifted (expected ${lock.sha256}, received ${actual})`,
  );
}
console.log(`AuthFn schema ${schema.version} matches ${actual}`);
