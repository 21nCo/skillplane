import { describe, expect, it } from "vitest";
import {
  PRODUCTION_APP_AUTHORITY,
  PRODUCTION_MCP_RESOURCE,
  TopologyError,
  createSingleCellTopology,
  parseTopologyManifest,
} from "./topology.js";

function productionTopology() {
  return {
    version: 1,
    mode: "multi-cell",
    public: {
      appAuthority: PRODUCTION_APP_AUTHORITY,
      mcpResource: PRODUCTION_MCP_RESOURCE,
    },
    controlPlane: {
      regionId: "global",
      databaseBinding: "CONTROL_HYPERDRIVE",
      publicObjectStorageBinding: "PUBLIC_SKILL_BUNDLES",
      issuer: PRODUCTION_APP_AUTHORITY,
      oauthResource: PRODUCTION_MCP_RESOURCE,
    },
    cells: [
      {
        regionId: "in-south",
        databaseBinding: "CELL_IN_SOUTH_HYPERDRIVE",
        objectStorageBinding: "CELL_IN_SOUTH_BUNDLES",
        appServiceBinding: "CELL_IN_SOUTH_APP",
        mcpServiceBinding: "CELL_IN_SOUTH_MCP",
        publiclyRoutable: false,
      },
      {
        regionId: "us-east",
        databaseBinding: "CELL_US_EAST_HYPERDRIVE",
        objectStorageBinding: "CELL_US_EAST_BUNDLES",
        appServiceBinding: "CELL_US_EAST_APP",
        mcpServiceBinding: "CELL_US_EAST_MCP",
        publiclyRoutable: false,
      },
    ],
    routing: {
      activeKeyId: "current",
      verificationKeyIds: ["current", "previous"],
      assertionAudience: "skillplane-cell",
      assertionTtlSeconds: 20,
    },
  };
}

describe("Skillplane topology manifest", () => {
  it("accepts a global control plane with two private regional cells", () => {
    const parsed = parseTopologyManifest(productionTopology(), {
      production: true,
    });
    expect(parsed.cells.map((cell) => cell.regionId)).toEqual(["in-south", "us-east"]);
    expect(parsed.cells.every((cell) => !cell.publiclyRoutable)).toBe(true);
  });

  it("keeps an explicit one-cell compatibility topology", () => {
    const parsed = createSingleCellTopology({
      appAuthority: "https://app-dev.skillplane.dev",
      mcpResource: "https://mcp-dev.skillplane.dev/mcp",
    });
    expect(parsed.mode).toBe("single-cell");
    expect(parsed.cells).toHaveLength(1);
  });

  it("rejects issuer drift, public cells, and duplicate bindings", () => {
    const issuerDrift = productionTopology();
    issuerDrift.controlPlane.issuer = "https://identity.example.test";
    expect(() => parseTopologyManifest(issuerDrift, { production: true })).toThrow(
      expect.objectContaining({ code: "TOPOLOGY_ISSUER_DRIFT" }),
    );

    const publicCell = productionTopology();
    const firstPublicCell = publicCell.cells[0];
    if (!firstPublicCell) throw new Error("topology fixture has no first cell");
    firstPublicCell.publiclyRoutable = true;
    expect(() => parseTopologyManifest(publicCell)).toThrow(TopologyError);

    const duplicate = productionTopology();
    const firstDuplicateCell = duplicate.cells[0];
    const secondDuplicateCell = duplicate.cells[1];
    if (!firstDuplicateCell || !secondDuplicateCell) {
      throw new Error("topology fixture requires two cells");
    }
    secondDuplicateCell.databaseBinding = firstDuplicateCell.databaseBinding;
    expect(() => parseTopologyManifest(duplicate)).toThrow(
      expect.objectContaining({ code: "TOPOLOGY_DUPLICATE_BINDING" }),
    );
  });
});
