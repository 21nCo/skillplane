#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { isMain, root, run } from "./lib/production-deployment.mjs";
import { renderDevelopmentTopologyConfigs } from "./render-development-topology-config.mjs";

export async function dryRunDevelopmentTopologyConfigs(options = {}) {
  const outputDirectory = resolve(
    root,
    ".data",
    "development-topology-config-dry-run",
    randomUUID(),
  );
  const rendered = await renderDevelopmentTopologyConfigs({
    controlHyperdriveId: "1".repeat(32),
    publicBucketName: "skillplane-public-bundles-dev",
    publicTurnstileSiteKey: "development-self-test-site-key",
    postHogProjectToken: `phc_${"d".repeat(32)}`,
    cells: {
      "in-south": {
        hyperdriveId: "2".repeat(32),
        bucketName: "skillplane-skill-bundles-dev",
      },
      "us-east": {
        hyperdriveId: "3".repeat(32),
        bucketName: "skillplane-us-east-bundles-dev",
      },
      "eu-west": {
        hyperdriveId: "4".repeat(32),
        bucketName: "skillplane-eu-west-bundles-dev",
      },
    },
    ...options,
  });
  try {
    for (const output of rendered.outputs) {
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          `${root}/${output.path}`,
          "--dry-run",
          "--strict",
          "--outdir",
          resolve(outputDirectory, output.id.replaceAll(":", "-")),
        ],
        {
          cwd: `${root}/${output.directory}`,
          failureMessage: `${output.id} development topology dry-run failed`,
        },
      );
    }
    return { ok: true, workers: rendered.outputs.map((output) => output.id) };
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await dryRunDevelopmentTopologyConfigs(), null, 2)}\n`,
  );
}
