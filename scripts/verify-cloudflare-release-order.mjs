#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { listCloudflareReleaseLedger } from "./lib/github-release-ledger.mjs";
import {
  activeCloudflareVersionId,
  assertCloudflareProductionOrder,
  resolveCloudflareRelease,
} from "./lib/release-tags.mjs";

const workerName = "skillplane-app";

function wrangler(args) {
  const result = spawnSync("pnpm", ["exec", "wrangler", ...args], {
    encoding: "utf8",
    env: process.env,
    maxBuffer: 10 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim() ||
        `wrangler ${args.join(" ")} failed`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`wrangler ${args.join(" ")} did not return valid JSON`);
  }
}

const requestedTag = process.argv[2] ?? process.env.SKILLPLANE_RELEASE_TAG;
resolveCloudflareRelease(requestedTag);
const ledgerTags = await listCloudflareReleaseLedger();
const versionId = activeCloudflareVersionId(
  wrangler(["deployments", "list", "--name", workerName, "--json"]),
);
const version = versionId
  ? wrangler(["versions", "view", versionId, "--name", workerName, "--json"])
  : null;
const deployedTag = versionId ? version?.annotations?.["workers/tag"] : null;
const order = assertCloudflareProductionOrder({
  requestedTag,
  deployedTag,
  ledgerTags,
  allowLegacyBootstrap: process.env.ALLOW_LEGACY_BOOTSTRAP === "true",
});
process.stdout.write(`${JSON.stringify({ ok: true, worker: workerName, ...order })}\n`);
