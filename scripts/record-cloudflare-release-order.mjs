#!/usr/bin/env node

import { recordCloudflareRelease } from "./lib/github-release-ledger.mjs";
import { resolveCloudflareRelease } from "./lib/release-tags.mjs";

const releaseTag = process.argv[2] ?? process.env.SKILLPLANE_RELEASE_TAG;
resolveCloudflareRelease(releaseTag);
const deploymentId = await recordCloudflareRelease(releaseTag);
process.stdout.write(`${JSON.stringify({ ok: true, releaseTag, deploymentId })}\n`);
