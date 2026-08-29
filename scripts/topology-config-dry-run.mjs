#!/usr/bin/env node

import { isMain, root, run } from "./lib/production-deployment.mjs";
import { renderTopologyDeploymentConfigs } from "./render-topology-config.mjs";

export async function dryRunTopologyConfigs(options = {}) {
  const rendered = await renderTopologyDeploymentConfigs(options);
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
