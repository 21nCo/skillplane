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
    compatibility_flags: ["nodejs_compat"],
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
  if (
    typeof input.publicTurnstileSiteKey !== "string" ||
    input.publicTurnstileSiteKey.length < 10
  ) {
    throw new Error("A production Turnstile site key is required");
  }
  const sharedVariables = {
    RUNTIME_ENV: "production",
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
    ...workerBase("skillplane-app", "app", {
      ...sharedVariables,
      SKILLPLANE_ROLE: "gateway",
      AUTH_MODE: "otp",
      EMAIL_PROVIDER: "cloudflare-email",
      TURNSTILE_ALLOWED_HOSTNAMES: "app.skillplane.dev",
      SKILLPLANE_OTP_FROM: "Skillplane <no-reply@auth.skillplane.dev>",
      PUBLIC_TURNSTILE_SITE_KEY: input.publicTurnstileSiteKey,
    }),
    routes: [{ pattern: "app.skillplane.dev", custom_domain: true }],
    hyperdrive: [{ binding: manifest.controlPlane.databaseBinding, id: controlId }],
    r2_buckets: [
      {
        binding: manifest.controlPlane.publicObjectStorageBinding,
        bucket_name: publicBucket,
      },
    ],
    services: manifest.cells.map((cell) => ({
      binding: cell.appServiceBinding,
      service: `skillplane-app-${cell.regionId}`,
    })),
    send_email: [
      {
        name: "SEND_EMAIL",
        allowed_sender_addresses: ["no-reply@auth.skillplane.dev"],
        remote: true,
      },
    ],
  };
  const mcpGateway = {
    ...workerBase("skillplane-mcp", "mcp", {
      ...sharedVariables,
      SKILLPLANE_ROLE: "gateway",
    }),
    routes: [{ pattern: "mcp.skillplane.dev", custom_domain: true }],
    hyperdrive: [{ binding: manifest.controlPlane.databaseBinding, id: controlId }],
    r2_buckets: [
      {
        binding: manifest.controlPlane.publicObjectStorageBinding,
        bucket_name: publicBucket,
      },
    ],
    services: manifest.cells.map((cell) => ({
      binding: cell.mcpServiceBinding,
      service: `skillplane-mcp-${cell.regionId}`,
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
            ...workerBase(`skillplane-app-${cell.regionId}`, "app", variables),
            ...bindings,
          },
          mcp: {
            ...workerBase(`skillplane-mcp-${cell.regionId}`, "mcp", variables),
            ...bindings,
          },
          projection: {
            ...workerBase(
              `skillplane-projection-${cell.regionId}`,
              "projection",
              variables,
            ),
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
