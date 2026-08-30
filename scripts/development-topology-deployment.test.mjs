import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderDevelopmentTopologyConfigs } from "./render-development-topology-config.mjs";

const ids = {
  control: "1".repeat(32),
  inSouth: "2".repeat(32),
  usEast: "3".repeat(32),
  euWest: "4".repeat(32),
};

describe("multi-cell development deployment", () => {
  it("renders isolated gateways and three private regional cells", async () => {
    const rendered = await renderDevelopmentTopologyConfigs({
      controlHyperdriveId: ids.control,
      publicBucketName: "skillplane-public-bundles-dev",
      publicTurnstileSiteKey: "development-turnstile-site-key",
      postHogProjectToken: `phc_${"d".repeat(32)}`,
      cells: {
        "in-south": {
          hyperdriveId: ids.inSouth,
          bucketName: "skillplane-skill-bundles-dev",
        },
        "us-east": {
          hyperdriveId: ids.usEast,
          bucketName: "skillplane-us-east-bundles-dev",
        },
        "eu-west": {
          hyperdriveId: ids.euWest,
          bucketName: "skillplane-eu-west-bundles-dev",
        },
      },
      write: false,
    });

    assert.equal(rendered.outputs.length, 11);
    const gatewayApp = rendered.outputs.find((output) => output.id === "gateway:app");
    const gatewayMcp = rendered.outputs.find((output) => output.id === "gateway:mcp");
    assert.equal(gatewayApp.config.name, "skillplane-app-dev");
    assert.equal(gatewayApp.config.routes[0].pattern, "app-dev.skillplane.dev");
    assert.equal(gatewayApp.config.vars.RUNTIME_ENV, "preview");
    assert.equal(
      gatewayApp.config.services.find(
        (service) => service.binding === "CELL_EU_WEST_APP",
      )?.service,
      "skillplane-app-dev-eu-west",
    );
    assert.equal(gatewayMcp.config.name, "skillplane-mcp-dev");
    assert.equal(gatewayMcp.config.routes[0].pattern, "mcp-dev.skillplane.dev");

    for (const output of rendered.outputs.filter((item) => item.regionId)) {
      assert.equal(output.config.routes, undefined);
      assert.equal(output.config.workers_dev, false);
      assert.equal(output.config.vars.RUNTIME_ENV, "preview");
      assert.equal(output.config.vars.SKILLPLANE_REGION_ID, output.regionId);
    }
  });

  it("rejects a Hyperdrive reused across control and cells", async () => {
    await assert.rejects(
      renderDevelopmentTopologyConfigs({
        controlHyperdriveId: ids.control,
        publicBucketName: "skillplane-public-bundles-dev",
        publicTurnstileSiteKey: "development-turnstile-site-key",
        postHogProjectToken: `phc_${"d".repeat(32)}`,
        cells: {
          "in-south": {
            hyperdriveId: ids.control,
            bucketName: "skillplane-skill-bundles-dev",
          },
          "us-east": {
            hyperdriveId: ids.usEast,
            bucketName: "skillplane-us-east-bundles-dev",
          },
          "eu-west": {
            hyperdriveId: ids.euWest,
            bucketName: "skillplane-eu-west-bundles-dev",
          },
        },
        write: false,
      }),
      /must be distinct/u,
    );
  });
});
