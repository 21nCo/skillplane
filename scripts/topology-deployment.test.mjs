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
      for (const worker of Object.values(pair)) {
        assert.equal(worker.routes, undefined);
        assert.equal(worker.services, undefined);
        assert.equal(worker.workers_dev, false);
        assert.equal(worker.vars.SKILLPLANE_ROLE, "cell");
        assert.equal(worker.vars.SKILLPLANE_REGION_ID, regionId);
        assert.equal(worker.hyperdrive.length, 2);
        assert.equal(worker.r2_buckets.length, 1);
        assert.equal(worker.send_email, undefined);
      }
    }
  });
});
