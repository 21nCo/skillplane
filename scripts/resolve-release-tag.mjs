#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePackageRelease, writeGithubOutputs } from "./lib/release-tags.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const release = await resolvePackageRelease(
  process.argv[2] ?? process.env.GITHUB_REF_NAME,
  root,
);

await writeGithubOutputs({
  pkg_slug: release.slug,
  pkg_name: release.name,
  pkg_version: release.version,
  pkg_path: release.path,
  npm_tag: release.npmTag,
});
process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
