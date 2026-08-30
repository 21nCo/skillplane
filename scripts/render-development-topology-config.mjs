#!/usr/bin/env node

import { resolve } from "node:path";
import {
  developmentBucket,
  developmentPostHogHost,
  developmentPostHogProjectToken,
  developmentPostHogProxyHost,
  developmentSiteKey,
  requireDevelopmentHyperdriveId,
} from "./lib/development-deployment.mjs";
import {
  isMain,
  portablePath,
  requireEnvironment,
  root,
  sha256,
  writeJsonAtomic,
} from "./lib/production-deployment.mjs";
import {
  createCloudflareTopologyConfigs,
  readDevelopmentTopology,
} from "./lib/topology-deployment.mjs";

function regionEnvironment(regionId, suffix) {
  return `CLOUDFLARE_DEV_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_${suffix}`;
}

function regionBucketEnvironment(regionId) {
  return `SKILLPLANE_DEV_CELL_${regionId.replaceAll("-", "_").toUpperCase()}_BUCKET`;
}

function bucket(value, label) {
  if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value ?? "")) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function defaultCellBucket(regionId) {
  return regionId === "in-south"
    ? developmentBucket
    : `skillplane-${regionId}-bundles-dev`;
}

export async function renderDevelopmentTopologyConfigs(options = {}) {
  const manifest = options.manifest ?? (await readDevelopmentTopology());
  const controlHyperdriveId = requireDevelopmentHyperdriveId(
    options.controlHyperdriveId ??
      requireEnvironment("CLOUDFLARE_DEV_CONTROL_HYPERDRIVE_ID"),
  );
  const cells = Object.fromEntries(
    manifest.cells.map((cell) => {
      const hyperdriveName = regionEnvironment(cell.regionId, "HYPERDRIVE_ID");
      const bucketName = regionBucketEnvironment(cell.regionId);
      return [
        cell.regionId,
        {
          hyperdriveId: requireDevelopmentHyperdriveId(
            options.cells?.[cell.regionId]?.hyperdriveId ??
              (cell.regionId === "in-south"
                ? process.env.CLOUDFLARE_DEV_HYPERDRIVE_ID
                : undefined) ??
              requireEnvironment(hyperdriveName),
          ),
          bucketName: bucket(
            options.cells?.[cell.regionId]?.bucketName ??
              process.env[bucketName] ??
              defaultCellBucket(cell.regionId),
            bucketName,
          ),
        },
      ];
    }),
  );
  const hyperdriveIds = [
    controlHyperdriveId,
    ...Object.values(cells).map((cell) => cell.hyperdriveId),
  ];
  if (new Set(hyperdriveIds).size !== hyperdriveIds.length) {
    throw new Error("Development control and cell Hyperdrives must be distinct");
  }
  const publicBucketName = bucket(
    options.publicBucketName ??
      process.env.SKILLPLANE_DEV_PUBLIC_BUCKET ??
      "skillplane-public-bundles-dev",
    "SKILLPLANE_DEV_PUBLIC_BUCKET",
  );
  const postHogProjectToken =
    options.postHogProjectToken ?? developmentPostHogProjectToken();
  const configs = createCloudflareTopologyConfigs({
    manifest,
    controlHyperdriveId,
    publicBucketName,
    cells,
    publicTurnstileSiteKey: options.publicTurnstileSiteKey ?? developmentSiteKey(),
    runtimeEnvironment: "preview",
    otpFrom: "Skillplane Dev <no-reply@auth-dev.skillplane.dev>",
    emailSender: "no-reply@auth-dev.skillplane.dev",
    appVariables: {
      PUBLIC_POSTHOG_KEY: postHogProjectToken,
      PUBLIC_POSTHOG_HOST: developmentPostHogProxyHost,
    },
    mcpVariables: { POSTHOG_HOST: developmentPostHogHost },
    workerNames: {
      appGateway: "skillplane-app-dev",
      mcpGateway: "skillplane-mcp-dev",
      appCell: (regionId) => `skillplane-app-dev-${regionId}`,
      mcpCell: (regionId) => `skillplane-mcp-dev-${regionId}`,
      projection: (regionId) => `skillplane-projection-dev-${regionId}`,
    },
  });
  const outputs = [
    {
      id: "gateway:app",
      directory: resolve(root, "app"),
      path: resolve(root, "app", "wrangler.development.topology.generated.json"),
      config: configs.gateway.app,
      kind: "app",
    },
    {
      id: "gateway:mcp",
      directory: resolve(root, "mcp"),
      path: resolve(root, "mcp", "wrangler.development.topology.generated.json"),
      config: configs.gateway.mcp,
      kind: "mcp",
    },
    ...manifest.cells.flatMap((cell) =>
      ["app", "mcp", "projection"].map((kind) => ({
        id: `${cell.regionId}:${kind}`,
        regionId: cell.regionId,
        directory: resolve(root, kind),
        path: resolve(
          root,
          kind,
          `wrangler.development.${cell.regionId}.generated.json`,
        ),
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
    environment: "development",
    manifest,
    resources: { controlHyperdriveId, publicBucketName, cells },
    outputs: outputs.map((output) => ({
      ...output,
      path: portablePath(output.path),
      directory: portablePath(output.directory),
      sha256: sha256(JSON.stringify(output.config)),
    })),
  };
}

if (isMain(import.meta.url)) {
  const result = await renderDevelopmentTopologyConfigs();
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: result.ok,
        environment: result.environment,
        outputs: result.outputs.map(({ id, path }) => ({ id, path })),
      },
      null,
      2,
    )}\n`,
  );
}
