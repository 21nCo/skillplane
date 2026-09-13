#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  assertCloudflareReleaseOrder,
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

function activeVersion(deployments) {
  if (!Array.isArray(deployments)) {
    throw new Error("Wrangler deployments output must be an array");
  }
  if (deployments.length === 0) return null;
  const versions = deployments.at(-1)?.versions;
  if (!Array.isArray(versions)) {
    throw new Error("Wrangler's active deployment omitted its versions");
  }
  const active = versions.find((version) => Number(version?.percentage) === 100);
  if (versions.length > 0 && typeof active?.version_id !== "string") {
    throw new Error(`${workerName} uses split traffic; release order is ambiguous`);
  }
  return active?.version_id ?? null;
}

const requestedTag = process.argv[2] ?? process.env.SKILLPLANE_RELEASE_TAG;
resolveCloudflareRelease(requestedTag);
const versionId = activeVersion(
  wrangler(["deployments", "list", "--name", workerName, "--json"]),
);
if (!versionId) {
  process.stdout.write("No active production deployment; allowing initial release\n");
  process.exit(0);
}

const version = wrangler([
  "versions",
  "view",
  versionId,
  "--name",
  workerName,
  "--json",
]);
const deployedTag = version?.annotations?.["workers/tag"];
try {
  resolveCloudflareRelease(deployedTag);
} catch (error) {
  if (
    typeof deployedTag === "string" &&
    deployedTag.startsWith("skillplane-cloudflare-v")
  ) {
    throw error;
  }
  process.stdout.write(
    `Active production version ${versionId} predates tagged releases; allowing bootstrap\n`,
  );
  process.exit(0);
}

assertCloudflareReleaseOrder(deployedTag, requestedTag);
process.stdout.write(
  `${JSON.stringify({ ok: true, worker: workerName, deployedTag, requestedTag })}\n`,
);
