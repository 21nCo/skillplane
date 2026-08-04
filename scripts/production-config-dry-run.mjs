#!/usr/bin/env node

import { rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { isMain, root, run, workers } from "./lib/production-deployment.mjs";
import { renderDeploymentConfigs } from "./render-deploy-config.mjs";

export async function productionConfigDryRun() {
  const outputDirectory = resolve(root, ".data", "production-config-dry-run");
  const outputPaths = Object.fromEntries(
    Object.keys(workers).map((kind) => [
      kind,
      resolve(root, kind, "wrangler.production-self-test.json"),
    ]),
  );
  try {
    await renderDeploymentConfigs({
      hyperdriveId: crypto.randomUUID().replaceAll("-", ""),
      siteKey: `self-test-${crypto.randomUUID()}`,
      outputPaths,
    });
    const results = {};
    for (const kind of ["app", "mcp"]) {
      run(
        "pnpm",
        [
          "exec",
          "wrangler",
          "deploy",
          "--config",
          outputPaths[kind],
          "--dry-run",
          "--strict",
          "--outdir",
          resolve(outputDirectory, kind),
        ],
        {
          cwd: workers[kind].directory,
          failureMessage: `${workers[kind].name} production config dry-run failed`,
        },
      );
      results[kind] = { ok: true, worker: workers[kind].name };
    }
    return { ok: true, workers: results };
  } finally {
    await Promise.all(
      Object.values(outputPaths).map((path) => unlink(path).catch(() => undefined)),
    );
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await productionConfigDryRun(), null, 2)}\n`);
}
