#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { packagePublishDecision, writeGithubOutputs } from "./lib/release-tags.mjs";

const [packageName, requestedVersion, npmTag] = process.argv.slice(2);
if (packageName !== "skillplane" || !["latest", "next"].includes(npmTag)) {
  throw new Error("Expected the public skillplane package and a supported npm tag");
}

const result = spawnSync(
  "npm",
  [
    "view",
    packageName,
    "dist-tags",
    "--json",
    "--registry",
    "https://registry.npmjs.org",
  ],
  {
    encoding: "utf8",
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
if (result.error) throw result.error;
let distTags = {};
if (result.status === 0) {
  distTags = JSON.parse(result.stdout);
} else if (!/\bE404\b/u.test(`${result.stdout ?? ""}\n${result.stderr ?? ""}`)) {
  throw new Error("Could not read the package's npm distribution tags");
}
if (!distTags || typeof distTags !== "object" || Array.isArray(distTags)) {
  throw new Error("npm distribution tags must be an object");
}
const publishedVersion = distTags[npmTag];
if (publishedVersion !== undefined && typeof publishedVersion !== "string") {
  throw new Error(`npm distribution tag ${npmTag} has an invalid version`);
}
const decision = packagePublishDecision(publishedVersion, requestedVersion);
await writeGithubOutputs({ publish: String(decision.publish) });
process.stdout.write(
  `${JSON.stringify({ ok: true, packageName, npmTag, ...decision })}\n`,
);
