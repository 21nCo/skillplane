import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createCloudflareTopologyConfigs,
  readProductionTopology,
} from "./lib/topology-deployment.mjs";

const ids = {
  control: "1".repeat(32),
  inSouth: "2".repeat(32),
  usEast: "3".repeat(32),
};

describe("multi-cell Cloudflare topology adapter", () => {
  it("generates canonical gateways and two private least-privilege cells", async () => {
    const configs = createCloudflareTopologyConfigs({
      manifest: await readProductionTopology(),
      publicTurnstileSiteKey: "0x4AAAAAAAAAA-production-site-key",
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
    });
    assert.equal(configs.gateway.app.routes[0].pattern, "app.skillplane.dev");
    assert.equal(configs.gateway.mcp.routes[0].pattern, "mcp.skillplane.dev");
    assert.deepEqual(Object.keys(configs.cells).sort(), ["in-south", "us-east"]);
    for (const [regionId, pair] of Object.entries(configs.cells)) {
      for (const [kind, worker] of Object.entries(pair)) {
        assert.equal(worker.routes, undefined);
        assert.equal(worker.services, undefined);
        assert.equal(worker.workers_dev, false);
        assert.equal(worker.vars.SKILLPLANE_ROLE, "cell");
        assert.equal(worker.vars.SKILLPLANE_REGION_ID, regionId);
        assert.equal(worker.hyperdrive.length, 2);
        assert.equal(worker.r2_buckets.length, kind === "projection" ? 2 : 1);
        assert.equal(worker.send_email, undefined);
        if (kind === "projection") {
          assert.deepEqual(worker.triggers.crons, ["* * * * *"]);
        }
      }
    }
    assert.equal(configs.gateway.app.vars.AUTH_MODE, "otp");
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
    assert.throws(
      () =>
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
});
