import { DatafnRoutingError } from "@datafn/server";
import { describe, expect, it } from "vitest";
import {
  claimWorkspacePlacement,
  createMemoryWorkspacePlacementDirectory,
  createWorkspaceRoutingAssertions,
} from "./placement.js";
import {
  createRegionalWorkspaceGuard,
  createWorkspaceGateway,
  type RegionalCellTarget,
} from "./routing.js";

const SECRET = "fixture-routing-secret-material-with-more-than-32-bytes";

describe("workspace gateway and cell fencing", () => {
  it("routes two workspaces to their owning cells with signed assertions", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:a",
      regionId: "in-south",
    });
    await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:b",
      regionId: "us-east",
    });
    const assertions = createWorkspaceRoutingAssertions({
      activeKeyId: "current",
      keys: { current: SECRET },
    });
    const targets = new Map<string, RegionalCellTarget>();
    for (const regionId of ["in-south", "us-east"]) {
      const guard = createRegionalWorkspaceGuard({
        regionId,
        directory,
        verifier: assertions,
        assertionAudience: "skillplane-cell",
      });
      targets.set(regionId, {
        regionId,
        async fetch(request) {
          const workspaceId = request.headers.get("x-test-authorized-workspace");
          if (!workspaceId) throw new Error("test workspace header missing");
          try {
            const result = await guard.authorize(request, workspaceId);
            return Response.json({
              workspaceId,
              regionId,
              epoch: result.epoch,
              trustedWorkspace: result.request.headers.get(
                "x-skillplane-routed-workspace-id",
              ),
            });
          } catch (error) {
            if (error instanceof DatafnRoutingError) return error.toResponse();
            throw error;
          }
        },
      });
    }
    const gateway = createWorkspaceGateway({
      directory,
      resolveAuthorizedWorkspace: async (request) =>
        request.headers.get("x-test-authorized-workspace") ?? "",
      cells: {
        resolve: ({ regionId }) => {
          const target = targets.get(regionId);
          if (!target) throw new Error("cell unavailable");
          return target;
        },
      },
      signer: assertions,
      assertionAudience: "skillplane-cell",
    });

    for (const [workspaceId, regionId] of [
      ["workspace:a", "in-south"],
      ["workspace:b", "us-east"],
    ] as const) {
      const response = await gateway.handle(
        new Request("https://app.skillplane.dev/api/v1/skills", {
          headers: { "x-test-authorized-workspace": workspaceId },
        }),
      );
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        workspaceId,
        regionId,
        trustedWorkspace: workspaceId,
      });
    }
  });

  it("fences moving workspaces and never leaks a destination", async () => {
    const directory = createMemoryWorkspacePlacementDirectory();
    const { placement } = await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:moving",
      regionId: "in-south",
    });
    await directory.compareAndSet({
      namespace: placement.namespace,
      expectedEpoch: placement.epoch,
      expectedState: "active",
      next: {
        ...placement,
        epoch: placement.epoch + 1,
        state: "moving",
        movingToRegionId: "us-east",
        updatedAt: new Date().toISOString(),
      },
    });
    const assertions = createWorkspaceRoutingAssertions({
      activeKeyId: "current",
      keys: { current: SECRET },
    });
    const gateway = createWorkspaceGateway({
      directory,
      resolveAuthorizedWorkspace: async () => "workspace:moving",
      cells: {
        resolve: () => {
          throw new Error("must not dispatch while moving");
        },
      },
      signer: assertions,
      assertionAudience: "skillplane-cell",
    });
    const response = await gateway.handle(
      new Request("https://app.skillplane.dev/api/v1/skills"),
    );
    expect(response.status).toBe(409);
    const body = JSON.stringify(await response.json());
    expect(body).toContain("DATAFN_NAMESPACE_MOVING");
    expect(body).not.toContain("us-east");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects replayed assertions before regional execution", async () => {
    const now = Date.now();
    const directory = createMemoryWorkspacePlacementDirectory();
    await claimWorkspacePlacement({
      directory,
      workspaceId: "workspace:replay",
      regionId: "in-south",
      now: () => now,
    });
    const assertions = createWorkspaceRoutingAssertions({
      activeKeyId: "current",
      keys: { current: SECRET },
      now: () => now,
    });
    const assertion = await assertions.sign({
      version: 1,
      namespace: "workspace:replay",
      regionId: "in-south",
      epoch: 1,
      requestId: "request:replay",
      method: "GET",
      path: "/api/v1/skills",
      audience: "skillplane-cell",
      issuedAt: now,
      expiresAt: now + 20_000,
      nonce: "nonce:replay",
    });
    const guard = createRegionalWorkspaceGuard({
      regionId: "in-south",
      directory,
      verifier: assertions,
      assertionAudience: "skillplane-cell",
      now: () => now,
    });
    const request = () =>
      new Request("https://internal/api/v1/skills", {
        headers: {
          "x-request-id": "request:replay",
          "x-datafn-routing-assertion": assertion,
        },
      });
    await expect(guard.authorize(request(), "workspace:replay")).resolves.toMatchObject(
      {
        epoch: 1,
      },
    );
    await expect(guard.authorize(request(), "workspace:replay")).rejects.toMatchObject({
      code: "DATAFN_ROUTING_ASSERTION_INVALID",
    });
  });

  it("accepts the prior routing key during rotation and rejects it after retirement", async () => {
    const now = Date.now();
    const oldSigner = createWorkspaceRoutingAssertions({
      activeKeyId: "previous",
      keys: { previous: `${SECRET}-previous` },
      now: () => now,
    });
    const rotatingVerifier = createWorkspaceRoutingAssertions({
      activeKeyId: "current",
      keys: {
        current: `${SECRET}-current`,
        previous: `${SECRET}-previous`,
      },
      now: () => now,
    });
    const retiredVerifier = createWorkspaceRoutingAssertions({
      activeKeyId: "current",
      keys: { current: `${SECRET}-current` },
      now: () => now,
    });
    const assertion = await oldSigner.sign({
      version: 1,
      namespace: "workspace:rotation",
      regionId: "in-south",
      epoch: 1,
      requestId: "request:rotation",
      method: "GET",
      path: "/api/v1/skills",
      audience: "skillplane-cell",
      issuedAt: now,
      expiresAt: now + 20_000,
      nonce: "nonce:rotation",
    });
    expect(
      rotatingVerifier.verify(assertion, {
        namespace: "workspace:rotation",
        regionId: "in-south",
        epoch: 1,
        requestId: "request:rotation",
        method: "GET",
        path: "/api/v1/skills",
        audience: "skillplane-cell",
      }),
    ).toMatchObject({ namespace: "workspace:rotation", epoch: 1 });
    expect(() =>
      retiredVerifier.verify(assertion, {
        namespace: "workspace:rotation",
        regionId: "in-south",
        epoch: 1,
        requestId: "request:rotation",
        method: "GET",
        path: "/api/v1/skills",
        audience: "skillplane-cell",
      }),
    ).toThrow();
  });
});
