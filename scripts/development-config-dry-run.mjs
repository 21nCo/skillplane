#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  developmentWorkers,
  renderDevelopmentConfigs,
} from "./lib/development-deployment.mjs";
import { isMain, root, run } from "./lib/production-deployment.mjs";

export function developmentDryRunPaths(identifier = randomUUID()) {
  return {
    outputDirectory: resolve(root, ".data", "development-config-dry-run", identifier),
    outputPaths: Object.fromEntries(
      Object.entries(developmentWorkers).map(([kind, worker]) => [
        kind,
        resolve(worker.directory, `wrangler.development-self-test-${identifier}.json`),
      ]),
    ),
  };
}

export async function developmentConfigDryRun() {
  const { outputDirectory, outputPaths } = developmentDryRunPaths();
  try {
    await renderDevelopmentConfigs({
      hyperdriveId: "d".repeat(32),
      siteKey: "development-self-test-site-key",
      outputPaths,
    });
    run("pnpm", ["--filter", "@skillplane/config", "build"], {
      failureMessage: "Development config package build failed",
    });
    for (const [kind, worker] of Object.entries(developmentWorkers)) {
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
          cwd: worker.directory,
          env: {
            ...process.env,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, "--conditions=development"]
              .filter(Boolean)
              .join(" "),
          },
          failureMessage: `${worker.name} config dry-run failed`,
        },
      );
    }
    return {
      ok: true,
      environment: "development",
      workers: Object.keys(developmentWorkers),
    };
  } finally {
    await Promise.all(
      Object.values(outputPaths).map((path) => unlink(path).catch(() => undefined)),
    );
    await rm(outputDirectory, { recursive: true, force: true });
  }
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await developmentConfigDryRun(), null, 2)}\n`);
}
