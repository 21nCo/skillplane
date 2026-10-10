#!/usr/bin/env node

import { isMain, root, run } from "./lib/production-deployment.mjs";
import { readProductionTopology } from "./lib/topology-deployment.mjs";
import { renderTopologyDeploymentConfigs } from "./render-topology-config.mjs";

export async function dryRunTopologyConfigs(options = {}) {
  const manifest = options.manifest ?? (await readProductionTopology());
  const rendered = await renderTopologyDeploymentConfigs({
    manifest,
    controlHyperdriveId: "1".repeat(32),
    publicBucketName: "skillplane-public-bundles",
    publicTurnstileSiteKey: "production-self-test-site-key",
    postHogProjectToken: `phc_${"a".repeat(32)}`,
    cells: Object.fromEntries(
      manifest.cells.map((cell, index) => [
        cell.regionId,
        {
          hyperdriveId: String(index + 2).repeat(32),
          bucketName: `skillplane-${cell.regionId}-bundles`,
        },
      ]),
    ),
    ...options,
  });
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
        "--outdir",
        `dist-topology-${output.id.replaceAll(":", "-")}`,
      ],
      {
        cwd: `${root}/${output.directory}`,
        failureMessage: `${output.id} dry-run failed`,
      },
    );
  }
  return { ok: true, workers: rendered.outputs.map((output) => output.id) };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await dryRunTopologyConfigs(), null, 2)}\n`);
}
