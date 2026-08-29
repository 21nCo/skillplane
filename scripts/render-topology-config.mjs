#!/usr/bin/env node

import { resolve } from "node:path";
import {
  isMain,
  portablePath,
  publicTurnstileSiteKey,
  requireEnvironment,
  requireHyperdriveId,
  root,
  sha256,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";
import {
  createCloudflareTopologyConfigs,
  readProductionTopology,
} from "./lib/topology-deployment.mjs";

function regionEnvironment(regionId, suffix) {
  return `SKILLPLANE_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_${suffix}`;
}

function bucket(value, label) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value ?? "")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

export async function renderTopologyDeploymentConfigs(options = {}) {
  const manifest = options.manifest ?? (await readProductionTopology());
  const controlHyperdriveId = requireHyperdriveId(
    options.controlHyperdriveId ??
      process.env.CLOUDFLARE_CONTROL_HYPERDRIVE_ID ??
      process.env.CLOUDFLARE_HYPERDRIVE_ID,
  );
  const publicBucketName = bucket(
    options.publicBucketName ??
      process.env.SKILLPLANE_PUBLIC_BUCKET ??
      "skillplane-public-bundles",
    "SKILLPLANE_PUBLIC_BUCKET",
  );
  const cells = Object.fromEntries(
    manifest.cells.map((cell) => {
      const hyperdriveName = regionEnvironment(cell.regionId, "HYPERDRIVE_ID");
      const bucketName = regionEnvironment(cell.regionId, "BUCKET");
      return [
        cell.regionId,
        {
          hyperdriveId: requireHyperdriveId(
            options.cells?.[cell.regionId]?.hyperdriveId ??
              requireEnvironment(hyperdriveName),
          ),
          bucketName: bucket(
            options.cells?.[cell.regionId]?.bucketName ??
              requireEnvironment(bucketName),
            bucketName,
          ),
        },
      ];
    }),
  );
  const configs = createCloudflareTopologyConfigs({
    manifest,
    controlHyperdriveId,
    publicBucketName,
    cells,
    publicTurnstileSiteKey: options.publicTurnstileSiteKey ?? publicTurnstileSiteKey(),
  });
  const outputs = [
    {
      id: "gateway:app",
      directory: resolve(root, "app"),
      path: resolve(root, "app", "wrangler.generated.json"),
      config: configs.gateway.app,
      kind: "app",
    },
    {
      id: "gateway:mcp",
      directory: resolve(root, "mcp"),
      path: resolve(root, "mcp", "wrangler.generated.json"),
      config: configs.gateway.mcp,
      kind: "mcp",
    },
    ...manifest.cells.flatMap((cell) =>
      ["app", "mcp", "projection"].map((kind) => ({
        id: `${cell.regionId}:${kind}`,
        regionId: cell.regionId,
        directory: resolve(root, kind),
        path: resolve(root, kind, `wrangler.${cell.regionId}.generated.json`),
        config: configs.cells[cell.regionId][kind],
        kind,
      })),
    ),
  ];
  if (options.write !== false) {
    for (const output of outputs) {
      await writeJsonAtomic(output.path, output.config, { mode: 0o600 });
    }
  }
  return {
    ok: true,
    manifest,
    outputs: outputs.map((output) => ({
      ...output,
      path: portablePath(output.path),
      directory: portablePath(output.directory),
      sha256: sha256(JSON.stringify(output.config)),
    })),
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(
    `${JSON.stringify(await renderTopologyDeploymentConfigs(), null, 2)}\n`,
  );
}
