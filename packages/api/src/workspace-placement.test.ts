import { describe, expect, it } from "vitest";
import {
  clientLocationFromEdgeRequest,
  initialWorkspaceRegionForRequest,
  recommendedWorkspaceRegionFromEdge,
  trustedWorkspaceRegion,
} from "./workspace-placement.js";

function edgeRequest(cf: Record<string, unknown>): Request {
  return Object.assign(new Request("https://app.skillplane.dev/api/v1/workspaces"), {
    cf,
  });
}

describe("workspace placement request boundary", () => {
  it("normalizes Cloudflare coordinates and continent metadata", () => {
    expect(
      clientLocationFromEdgeRequest(
        edgeRequest({ latitude: "19.076", longitude: "72.8777", continent: "as" }),
      ),
    ).toEqual({ latitude: 19.076, longitude: 72.8777, continent: "AS" });
  });

  it("selects the nearest configured candidate from trusted edge metadata", () => {
    expect(
      recommendedWorkspaceRegionFromEdge(
        edgeRequest({ latitude: "48.8566", longitude: "2.3522", continent: "EU" }),
        [
          {
            regionId: "in-south",
            displayName: "India South",
            latitude: 19.076,
            longitude: 72.8777,
          },
          {
            regionId: "eu-west",
            displayName: "Europe West",
            latitude: 53.3498,
            longitude: -6.2603,
          },
        ],
      ),
    ).toBe("eu-west");
  });

  it("accepts the internal recommendation only in gateway services", () => {
    const request = new Request("https://app.skillplane.dev/api/v1/workspaces", {
      headers: { "x-skillplane-placement-region": "in-south" },
    });
    expect(
      trustedWorkspaceRegion(request, {
        deploymentRole: "gateway",
        workspaceRegions: ["in-south", "us-east"],
      }),
    ).toBe("in-south");
    expect(
      trustedWorkspaceRegion(request, {
        deploymentRole: "single",
        workspaceRegions: ["in-south", "us-east"],
      }),
    ).toBeNull();
  });

  it("uses the trusted gateway recommendation as the initial region", () => {
    const request = new Request("https://app.skillplane.dev/api/v1/workspaces", {
      headers: { "x-skillplane-placement-region": "in-south" },
    });
    expect(
      initialWorkspaceRegionForRequest(
        request,
        {
          deploymentRole: "gateway",
          workspaceRegions: ["in-south", "us-east"],
        },
        "user:one",
      ),
    ).toBe("in-south");
  });

  it("uses DataFn's opt-in stable fallback outside the gateway", () => {
    const services = {
      deploymentRole: "single" as const,
      workspaceRegions: ["in-south", "us-east"],
    };
    const first = initialWorkspaceRegionForRequest(
      new Request("https://app.skillplane.dev/api/v1/workspaces"),
      services,
      "user:stable",
    );
    const repeated = initialWorkspaceRegionForRequest(
      new Request("https://app.skillplane.dev/api/v1/workspaces"),
      services,
      "user:stable",
    );
    expect(repeated).toBe(first);
  });

  it("fails closed when a multi-cell gateway has no edge recommendation", () => {
    expect(() =>
      initialWorkspaceRegionForRequest(
        new Request("https://app.skillplane.dev/api/v1/workspaces"),
        {
          deploymentRole: "gateway",
          workspaceRegions: ["in-south", "us-east"],
        },
        "user:one",
      ),
    ).toThrow(
      expect.objectContaining({
        code: "WORKSPACE_REGION_UNAVAILABLE",
        status: 503,
      }),
    );
  });
});
