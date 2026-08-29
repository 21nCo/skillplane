import { describe, expect, it } from "vitest";
import { classifyApiScope, createRoutedApiApplication } from "./workspace-routing.js";

const objectStorage = {
  head: async () => null,
  get: async () => null,
  put: async () => null,
  delete: async () => undefined,
  list: async () => ({ objects: [] }),
};

describe("API scope classification", () => {
  it("keeps identity, membership, and public projection routes global", () => {
    for (const path of [
      "/auth/session",
      "/api/v1/workspaces/workspace%3Aone/members",
      "/api/v1/skills/public/acme/review",
      "/api/v1/stats/public",
    ]) {
      expect(
        classifyApiScope(new Request(`https://app.skillplane.dev${path}`)),
      ).toEqual({
        kind: "global",
      });
    }
  });

  it("routes workspace and regional resource paths", () => {
    expect(
      classifyApiScope(
        new Request(
          "https://app.skillplane.dev/api/v1/workspaces/workspace%3Aone/skills",
        ),
      ),
    ).toEqual({ kind: "workspace", workspaceId: "workspace:one" });
    expect(
      classifyApiScope(
        new Request("https://app.skillplane.dev/api/v1/skills/skill%3Aone"),
      ),
    ).toEqual({ kind: "resource", resourceType: "skill", resourceId: "skill:one" });
  });

  it("boots a private cell without gateway-only OTP or email bindings", async () => {
    const topology = {
      version: 1,
      mode: "multi-cell",
      public: {
        appAuthority: "http://localhost:5700",
        mcpResource: "http://127.0.0.1:5701/mcp",
      },
      controlPlane: {
        regionId: "global",
        databaseBinding: "CONTROL_DATABASE",
        publicObjectStorageBinding: "PUBLIC_BUNDLES",
        issuer: "http://localhost:5700",
        oauthResource: "http://127.0.0.1:5701/mcp",
      },
      cells: [
        {
          regionId: "in-south",
          databaseBinding: "CELL_DATABASE",
          objectStorageBinding: "CELL_BUNDLES",
          appServiceBinding: "CELL_APP",
          mcpServiceBinding: "CELL_MCP",
          publiclyRoutable: false,
        },
        {
          regionId: "us-east",
          databaseBinding: "OTHER_DATABASE",
          objectStorageBinding: "OTHER_BUNDLES",
          appServiceBinding: "OTHER_APP",
          mcpServiceBinding: "OTHER_MCP",
          publiclyRoutable: false,
        },
      ],
      routing: {
        activeKeyId: "current",
        verificationKeyIds: ["current"],
        assertionAudience: "skillplane-cell",
        assertionTtlSeconds: 20,
      },
    };
    const local = { fetch: async () => new Response("unexpected") };
    const services = async () => {
      throw new Error("global routes must not build regional services");
    };
    const routed = createRoutedApiApplication({ local, services });
    const response = await routed.fetch(new Request("http://localhost:5700/auth"), {
      RUNTIME_ENV: "local",
      DATABASE_ADAPTER: "postgres",
      OAUTH_ISSUER: "http://localhost:5700",
      OAUTH_RESOURCE: "http://127.0.0.1:5701/mcp",
      SKILLPLANE_ROLE: "cell",
      SKILLPLANE_REGION_ID: "in-south",
      SKILLPLANE_TOPOLOGY: JSON.stringify(topology),
      WORKSPACE_ROUTING_KEYS: JSON.stringify({
        current: "routing-secret-independent-from-oauth",
      }),
      CONTROL_DATABASE: "postgresql://skillplane:fixture@127.0.0.1:5432/control",
      CELL_DATABASE: "postgresql://skillplane:fixture@127.0.0.1:5432/cell",
      CELL_BUNDLES: objectStorage,
    });

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "REGIONAL_ROUTE_NOT_FOUND" },
    });
  });
});
