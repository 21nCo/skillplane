#!/usr/bin/env node

import { rm, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  developmentWorkers,
  renderDevelopmentConfigs,
} from "./lib/development-deployment.mjs";
import { root, run } from "./lib/production-deployment.mjs";

export async function developmentConfigDryRun() {
  const outputDirectory = resolve(root, ".data", "development-config-dry-run");
  const outputPaths = Object.fromEntries(
    Object.keys(developmentWorkers).map((kind) => [
      kind,
      resolve(root, kind, "wrangler.development-self-test.json"),
    ]),
  );
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

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await developmentConfigDryRun(), null, 2)}\n`);
}
