import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCloudflareTopologyConfigs,
  createTopologyParserLoader,
  readProductionTopology,
} from "./lib/topology-deployment.mjs";

const ids = {
  control: "1".repeat(32),
  inSouth: "2".repeat(32),
  usEast: "3".repeat(32),
};

describe("multi-cell Cloudflare topology adapter", () => {
  it("builds lazily before importing and caches the current parser", async () => {
    const calls = [];
    const expected = () => undefined;
    const load = createTopologyParserLoader({
      build: async () => {
        calls.push("build");
      },
      importParser: async () => {
        calls.push("import");
        return expected;
      },
    });

    assert.deepEqual(calls, []);
    assert.equal(await load(), expected);
    assert.equal(await load(), expected);
    assert.deepEqual(calls, ["build", "import"]);
  });

  it("generates canonical gateways and two private least-privilege cells", async () => {
    const configs = await createCloudflareTopologyConfigs({
      manifest: await readProductionTopology(),
      publicTurnstileSiteKey: "0x4AAAAAAAAAA-production-site-key",
      controlHyperdriveId: ids.control,
      publicBucketName: "skillplane-public-bundles",
      directDatafnEnabled: true,
      directDatafnWorkspaceIds: "workspace:canary",
      mcpVariables: { POSTHOG_HOST: "https://analytics.example.test" },
      cells: {
        "in-south": {
          hyperdriveId: ids.inSouth,
          bucketName: "skillplane-in-south-bundles",
        },
        "us-east": {
          hyperdriveId: ids.usEast,
          bucketName: "skillplane-us-east-bundles",
        },
      },
    });
    assert.equal(configs.gateway.app.routes[0].pattern, "app.skillplane.dev");
    assert.equal(configs.gateway.mcp.routes[0].pattern, "mcp.skillplane.dev");
    assert.deepEqual(Object.keys(configs.cells).sort(), ["in-south", "us-east"]);
    for (const [regionId, pair] of Object.entries(configs.cells)) {
      for (const [kind, worker] of Object.entries(pair)) {
        if (kind === "datafn") {
          assert.equal(worker.routes[0].pattern, `datafn-${regionId}.skillplane.dev`);
          assert.deepEqual(worker.services, [
            { binding: "CELL_APP", service: pair.app.name },
          ]);
          assert.equal(worker.hyperdrive, undefined);
          assert.equal(worker.r2_buckets, undefined);
          assert.equal(worker.ratelimits[0].name, "DATAFN_EDGE_LIMIT");
          assert.equal(worker.vars.DATAFN_DIRECT_ENABLED, "true");
          continue;
        }
        assert.equal(worker.routes, undefined);
        assert.equal(worker.services, undefined);
        assert.equal(worker.workers_dev, false);
        assert.equal(worker.vars.SKILLPLANE_ROLE, "cell");
        assert.equal(worker.vars.SKILLPLANE_REGION_ID, regionId);
        assert.equal(
          worker.vars.DATAFN_DIRECT_ENABLED,
          kind === "app" ? "true" : undefined,
        );
        assert.equal(worker.hyperdrive.length, 2);
        assert.equal(worker.r2_buckets.length, kind === "projection" ? 2 : 1);
        assert.equal(worker.send_email, undefined);
        if (kind === "projection") {
          assert.deepEqual(worker.triggers.crons, ["* * * * *"]);
        }
      }
    }
    for (const config of [
      configs.gateway.mcp,
      ...Object.values(configs.cells).map((cell) => cell.mcp),
    ]) {
      assert.equal(config.vars.POSTHOG_HOST, "https://analytics.example.test");
    }
    assert.equal(configs.gateway.app.vars.AUTH_MODE, "otp");
    assert.equal(configs.gateway.app.vars.DATAFN_DIRECT_WORKSPACES, "workspace:canary");
    assert.equal(configs.gateway.mcp.vars.DATAFN_DIRECT_ENABLED, undefined);
    assert.equal(configs.gateway.app.vars.EMAIL_PROVIDER, "cloudflare-email");
    assert.equal(configs.gateway.app.send_email[0].name, "SEND_EMAIL");
    assert.deepEqual(configs.gateway.mcp.compatibility_flags, [
      "nodejs_compat",
      "allow_eval_during_startup",
    ]);
    assert.deepEqual(configs.gateway.app.compatibility_flags, ["nodejs_compat"]);
    for (const pair of Object.values(configs.cells)) {
      assert.deepEqual(pair.mcp.compatibility_flags, [
        "nodejs_compat",
        "allow_eval_during_startup",
      ]);
      assert.deepEqual(pair.app.compatibility_flags, ["nodejs_compat"]);
      assert.deepEqual(pair.projection.compatibility_flags, ["nodejs_compat"]);
    }
  });

  it("rejects bucket reuse across public and regional storage", async () => {
    const manifest = await readProductionTopology();
    await assert.rejects(
      async () =>
        createCloudflareTopologyConfigs({
          manifest,
          publicTurnstileSiteKey: "0x4AAAAAAAAAA-production-site-key",
          controlHyperdriveId: ids.control,
          publicBucketName: "skillplane-public-bundles",
          cells: {
            "in-south": {
              hyperdriveId: ids.inSouth,
              bucketName: "skillplane-public-bundles",
            },
            "us-east": {
              hyperdriveId: ids.usEast,
              bucketName: "skillplane-us-east-bundles",
            },
          },
        }),
      /must be distinct/u,
    );
  });

  it("rejects one custom-domain host assigned to separate app and MCP Workers", async () => {
    const manifest = await readProductionTopology();
    manifest.public.appAuthority = "https://gateway-preview.skillplane.dev";
    manifest.public.mcpResource = "https://gateway-preview.skillplane.dev/mcp";
    manifest.controlPlane.issuer = manifest.public.appAuthority;
    manifest.controlPlane.oauthResource = manifest.public.mcpResource;

    await assert.rejects(
      createCloudflareTopologyConfigs({
        manifest,
        runtimeEnvironment: "preview",
        publicTurnstileSiteKey: "0x4AAAAAAAAAA-preview-site-key",
        controlHyperdriveId: ids.control,
        publicBucketName: "skillplane-public-bundles",
        cells: {
          "in-south": {
            hyperdriveId: ids.inSouth,
            bucketName: "skillplane-in-south-bundles",
          },
          "us-east": {
            hyperdriveId: ids.usEast,
            bucketName: "skillplane-us-east-bundles",
          },
        },
      }),
      /cannot be assigned to both app gateway and MCP gateway/u,
    );
  });

  it("rejects ports before emitting Cloudflare custom domains", async () => {
    for (const owner of ["app", "mcp", "datafn"]) {
      const manifest = await readProductionTopology();
      if (owner === "app") {
        manifest.public.appAuthority = "https://app-preview.skillplane.dev:8443";
        manifest.controlPlane.issuer = manifest.public.appAuthority;
      } else if (owner === "mcp") {
        manifest.public.mcpResource = "https://mcp-preview.skillplane.dev:8443/mcp";
        manifest.controlPlane.oauthResource = manifest.public.mcpResource;
      } else {
        manifest.cells[0].datafnEndpoint = {
          httpUrl: "https://datafn-shared.skillplane.dev:8443/datafn",
          wsUrl: "wss://datafn-shared.skillplane.dev:8443/datafn",
          audience: "skillplane-datafn-in",
        };
        manifest.cells[1].datafnEndpoint = {
          httpUrl: "https://datafn-shared.skillplane.dev:9443/datafn",
          wsUrl: "wss://datafn-shared.skillplane.dev:9443/datafn",
          audience: "skillplane-datafn-us",
        };
      }

      await assert.rejects(
        createCloudflareTopologyConfigs({
          manifest,
          runtimeEnvironment: "preview",
          publicTurnstileSiteKey: "0x4AAAAAAAAAA-preview-site-key",
          controlHyperdriveId: ids.control,
          publicBucketName: "skillplane-public-bundles",
          cells: {
            "in-south": {
              hyperdriveId: ids.inSouth,
              bucketName: "skillplane-in-south-bundles",
            },
            "us-east": {
              hyperdriveId: ids.usEast,
              bucketName: "skillplane-us-east-bundles",
            },
          },
        }),
        /custom domain must not include a port/u,
        owner,
      );
    }
  });

  it("rejects an empty direct-routing workspace list", async () => {
    await assert.rejects(
      createCloudflareTopologyConfigs({
        manifest: await readProductionTopology(),
        publicTurnstileSiteKey: "0x4AAAAAAAAAA-production-site-key",
        controlHyperdriveId: ids.control,
        publicBucketName: "skillplane-public-bundles",
        directDatafnEnabled: true,
        directDatafnWorkspaceIds: " ,  , ",
        cells: {
          "in-south": {
            hyperdriveId: ids.inSouth,
            bucketName: "skillplane-in-south-bundles",
          },
          "us-east": {
            hyperdriveId: ids.usEast,
            bucketName: "skillplane-us-east-bundles",
          },
        },
      }),
      /Direct DataFn needs workspace IDs/u,
    );
  });
});

it("reports bucket identities matching every generated Worker binding", async () => {
  const { renderTopologyDeploymentConfigs } =
    await import("./render-topology-config.mjs");
  const manifest = await readProductionTopology();
  const cells = Object.fromEntries(
    manifest.cells.map((cell, index) => [
      cell.regionId,
      {
        hyperdriveId: String(index + 2).repeat(32),
        bucketName: `test-${cell.regionId}-bundles`,
      },
    ]),
  );
  const rendered = await renderTopologyDeploymentConfigs({
    manifest,
    cells,
    controlHyperdriveId: ids.control,
    publicBucketName: "test-public-bundles",
    publicTurnstileSiteKey: "test-only-site-key",
    postHogProjectToken: "test-only-analytics-token",
    write: false,
  });
  assert.equal(rendered.buckets.public, "test-public-bundles");
  assert.deepEqual(
    rendered.buckets.cells,
    Object.fromEntries(
      Object.entries(cells).map(([region, cell]) => [region, cell.bucketName]),
    ),
  );
  for (const output of rendered.outputs) {
    const names = (output.config.r2_buckets ?? [])
      .map((binding) => binding.bucket_name)
      .sort();
    const expected = output.id.startsWith("gateway:")
      ? [rendered.buckets.public]
      : output.kind === "datafn"
        ? []
        : output.kind === "projection"
          ? [rendered.buckets.public, rendered.buckets.cells[output.regionId]]
          : [rendered.buckets.cells[output.regionId]];
    assert.deepEqual(names, expected.sort());
  }
});
