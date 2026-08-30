import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { root } from "./production-deployment.mjs";

const hyperdriveId = /^[a-f0-9]{32}$/u;
const bucketName = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;

function requireResource(value, pattern, label) {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function workerBase(name, kind, variables) {
  return {
    $schema: "../node_modules/wrangler/config-schema.json",
    name,
    main: kind === "app" ? ".svelte-kit/cloudflare/_worker.js" : "src/index.ts",
    compatibility_date: "2026-05-03",
    compatibility_flags:
      kind === "mcp"
        ? ["nodejs_compat", "allow_eval_during_startup"]
        : ["nodejs_compat"],
    workers_dev: false,
    ...(kind === "app"
      ? {
          assets: {
            binding: "ASSETS",
            directory: ".svelte-kit/cloudflare",
          },
        }
      : {
          rules: [
            {
              type: "Data",
              globs: ["**/*.png", "**/*.ico"],
              fallthrough: true,
            },
          ],
        }),
    vars: variables,
    observability: { enabled: true, head_sampling_rate: 1 },
  };
}

/**
 * Cloudflare adapter for the provider-neutral topology manifest. Regional
 * workers intentionally have neither routes nor workers.dev exposure.
 */
export function createCloudflareTopologyConfigs(input) {
  const manifest = input.manifest;
  if (
    manifest?.version !== 1 ||
    manifest.mode !== "multi-cell" ||
    !Array.isArray(manifest.cells) ||
    manifest.cells.length < 2
  ) {
    throw new Error("A multi-cell topology with at least two cells is required");
  }
  const topology = JSON.stringify(manifest);
  const runtimeEnvironment = input.runtimeEnvironment ?? "production";
  if (!["production", "preview"].includes(runtimeEnvironment)) {
    throw new Error("The topology runtime environment is invalid");
  }
  const appHost = new URL(manifest.public.appAuthority).host;
  const mcpHost = new URL(manifest.public.mcpResource).host;
  const names = {
    appGateway: input.workerNames?.appGateway ?? "skillplane-app",
    mcpGateway: input.workerNames?.mcpGateway ?? "skillplane-mcp",
    appCell: input.workerNames?.appCell ?? ((regionId) => `skillplane-app-${regionId}`),
    mcpCell: input.workerNames?.mcpCell ?? ((regionId) => `skillplane-mcp-${regionId}`),
    projection:
      input.workerNames?.projection ??
      ((regionId) => `skillplane-projection-${regionId}`),
  };
  if (
    typeof input.publicTurnstileSiteKey !== "string" ||
    input.publicTurnstileSiteKey.length < 10
  ) {
    throw new Error("A production Turnstile site key is required");
  }
  const sharedVariables = {
    RUNTIME_ENV: runtimeEnvironment,
    DATABASE_ADAPTER: "postgres",
    OAUTH_ISSUER: manifest.public.appAuthority,
    OAUTH_RESOURCE: manifest.public.mcpResource,
    SKILLPLANE_TOPOLOGY: topology,
  };
  const controlId = requireResource(
    input.controlHyperdriveId,
    hyperdriveId,
    "control Hyperdrive ID",
  );
  const publicBucket = requireResource(
    input.publicBucketName,
    bucketName,
    "public bucket name",
  );
  const appGateway = {
    ...workerBase(names.appGateway, "app", {
      ...sharedVariables,
      SKILLPLANE_ROLE: "gateway",
      AUTH_MODE: "otp",
      EMAIL_PROVIDER: "cloudflare-email",
      TURNSTILE_ALLOWED_HOSTNAMES: appHost,
      SKILLPLANE_OTP_FROM: input.otpFrom ?? "Skillplane <no-reply@auth.skillplane.dev>",
      PUBLIC_TURNSTILE_SITE_KEY: input.publicTurnstileSiteKey,
      ...(input.appVariables ?? {}),
    }),
    routes: [{ pattern: appHost, custom_domain: true }],
    hyperdrive: [{ binding: manifest.controlPlane.databaseBinding, id: controlId }],
    r2_buckets: [
      {
        binding: manifest.controlPlane.publicObjectStorageBinding,
        bucket_name: publicBucket,
      },
    ],
    services: manifest.cells.map((cell) => ({
      binding: cell.appServiceBinding,
      service: names.appCell(cell.regionId),
    })),
    send_email: [
      {
        name: "SEND_EMAIL",
        allowed_sender_addresses: [input.emailSender ?? "no-reply@auth.skillplane.dev"],
        remote: true,
      },
    ],
  };
  const mcpGateway = {
    ...workerBase(names.mcpGateway, "mcp", {
      ...sharedVariables,
      SKILLPLANE_ROLE: "gateway",
      ...(input.mcpVariables ?? {}),
    }),
    routes: [{ pattern: mcpHost, custom_domain: true }],
    hyperdrive: [{ binding: manifest.controlPlane.databaseBinding, id: controlId }],
    r2_buckets: [
      {
        binding: manifest.controlPlane.publicObjectStorageBinding,
        bucket_name: publicBucket,
      },
    ],
    services: manifest.cells.map((cell) => ({
      binding: cell.mcpServiceBinding,
      service: names.mcpCell(cell.regionId),
    })),
  };
  const cells = Object.fromEntries(
    manifest.cells.map((cell) => {
      if (cell.publiclyRoutable !== false) {
        throw new Error(`Cell ${cell.regionId} must be private`);
      }
      const resources = input.cells?.[cell.regionId];
      const regionalId = requireResource(
        resources?.hyperdriveId,
        hyperdriveId,
        `${cell.regionId} Hyperdrive ID`,
      );
      const regionalBucket = requireResource(
        resources?.bucketName,
        bucketName,
        `${cell.regionId} bucket name`,
      );
      const variables = {
        ...sharedVariables,
        SKILLPLANE_ROLE: "cell",
        SKILLPLANE_REGION_ID: cell.regionId,
      };
      const bindings = {
        hyperdrive: [
          { binding: manifest.controlPlane.databaseBinding, id: controlId },
          { binding: cell.databaseBinding, id: regionalId },
        ],
        r2_buckets: [
          { binding: cell.objectStorageBinding, bucket_name: regionalBucket },
        ],
      };
      return [
        cell.regionId,
        {
          app: {
            ...workerBase(names.appCell(cell.regionId), "app", variables),
            ...bindings,
          },
          mcp: {
            ...workerBase(names.mcpCell(cell.regionId), "mcp", variables),
            ...bindings,
          },
          projection: {
            ...workerBase(names.projection(cell.regionId), "projection", variables),
            main: "src/index.ts",
            hyperdrive: [
              { binding: "CONTROL_DATABASE", id: controlId },
              { binding: "CELL_DATABASE", id: regionalId },
            ],
            r2_buckets: [
              { binding: "CELL_BUNDLES", bucket_name: regionalBucket },
              { binding: "PUBLIC_BUNDLES", bucket_name: publicBucket },
            ],
            triggers: { crons: ["* * * * *"] },
          },
        },
      ];
    }),
  );
  return { gateway: { app: appGateway, mcp: mcpGateway }, cells };
}

export async function readProductionTopology() {
  return JSON.parse(
    await readFile(resolve(root, "deployment", "topology.production.json"), "utf8"),
  );
}

export async function readDevelopmentTopology() {
  return JSON.parse(
    await readFile(resolve(root, "deployment", "topology.development.json"), "utf8"),
  );
}
