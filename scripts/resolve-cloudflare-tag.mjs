#!/usr/bin/env node

import { resolveCloudflareRelease } from "./lib/release-tags.mjs";

const release = resolveCloudflareRelease(
  process.argv[2] ?? process.env.GITHUB_REF_NAME,
);
process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
