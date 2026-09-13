#!/usr/bin/env node

import { resolveCloudflareRelease, writeGithubOutputs } from "./lib/release-tags.mjs";

const release = resolveCloudflareRelease(
  process.argv[2] ?? process.env.GITHUB_REF_NAME,
);
await writeGithubOutputs({
  release_tag: release.tag,
  release_version: release.version,
});
process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
