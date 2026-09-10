import { describe, expect, it } from "vitest";
import {
  classifyApiScope,
  classifyDatafnAuthority,
  createRoutedApiApplication,
} from "./workspace-routing.js";

const objectStorage = {
  head: async () => null,
  get: async () => null,
  put: async () => null,
  delete: async () => undefined,
  list: async () => ({ objects: [] }),
};

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
      placement: {
        displayName: "India South",
        latitude: 19.076,
        longitude: 72.8777,
      },
      databaseBinding: "CELL_DATABASE",
      objectStorageBinding: "CELL_BUNDLES",
      appServiceBinding: "CELL_APP",
      mcpServiceBinding: "CELL_MCP",
      publiclyRoutable: false,
    },
    {
      regionId: "us-east",
      placement: {
        displayName: "US East",
        latitude: 39.0438,
        longitude: -77.4874,
      },
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
} as const;

const gatewayBindings = {
  RUNTIME_ENV: "local",
  DATABASE_ADAPTER: "postgres",
  AUTH_MODE: "disabled",
  OAUTH_ISSUER: "http://localhost:5700",
  OAUTH_RESOURCE: "http://127.0.0.1:5701/mcp",
  SKILLPLANE_ROLE: "gateway",
  SKILLPLANE_TOPOLOGY: JSON.stringify(topology),
  WORKSPACE_ROUTING_KEYS: JSON.stringify({
    current: "routing-secret-independent-from-oauth",
  }),
  CONTROL_DATABASE: "postgresql://skillplane:fixture@127.0.0.1:5432/control",
  PUBLIC_BUNDLES: objectStorage,
};

describe("API scope classification", () => {
  it("replaces a public placement header with the trusted edge recommendation", async () => {
    const routed = createRoutedApiApplication({
      local: {
        fetch: async (request) =>
          Response.json({
            regionId: request.headers.get("x-skillplane-placement-region"),
          }),
      },
      services: async () => {
        throw new Error("global route must not initialize routing services");
      },
    });
    const request = Object.assign(
      new Request("http://localhost:5700/api/v1/workspaces", {
        headers: { "x-skillplane-placement-region": "us-east" },
      }),
      { cf: { latitude: "19.076", longitude: "72.8777", continent: "AS" } },
    );

    const response = await routed.fetch(request, gatewayBindings);

    await expect(response.json()).resolves.toEqual({ regionId: "in-south" });
  });

  it("removes a public placement header when edge location is unavailable", async () => {
    const routed = createRoutedApiApplication({
      local: {
        fetch: async (request) =>
          Response.json({
            regionId: request.headers.get("x-skillplane-placement-region"),
          }),
      },
      services: async () => {
        throw new Error("global route must not initialize routing services");
      },
    });

    const response = await routed.fetch(
      new Request("http://localhost:5700/api/v1/workspaces", {
        headers: { "x-skillplane-placement-region": "us-east" },
      }),
      gatewayBindings,
    );

    await expect(response.json()).resolves.toEqual({ regionId: null });
  });

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

  it("routes header-scoped skill searches to the workspace cell", () => {
    expect(
      classifyApiScope(
        new Request("https://app.skillplane.dev/api/v1/skills/search", {
          headers: { "x-skillplane-workspace-id": "workspace:one" },
        }),
      ),
    ).toEqual({ kind: "workspace", workspaceId: "workspace:one" });
  });

  it("rejects malformed percent-encoded routing segments", () => {
    expect(() =>
      classifyApiScope(new Request("https://app.skillplane.dev/api/v1/skills/%ZZ")),
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "WORKSPACE_ROUTE_INVALID",
      }),
    );
    expect(() =>
      classifyApiScope(
        new Request("https://app.skillplane.dev/api/v1/skills/search", {
          headers: { "x-skillplane-workspace-id": "%E0%A4%A" },
        }),
      ),
    ).toThrowError(
      expect.objectContaining({
        status: 400,
        code: "WORKSPACE_ROUTE_INVALID",
      }),
    );
  });

  it("returns the stable routing error for malformed gateway input", async () => {
    const routed = createRoutedApiApplication({
      local: { fetch: async () => new Response("unexpected local response") },
      services: async () => {
        throw new Error("services must not be initialized for invalid routing input");
      },
    });

    const response = await routed.fetch(
      new Request("http://localhost:5700/api/v1/skills/search", {
        headers: { "x-skillplane-workspace-id": "%E0%A4%A" },
      }),
      gatewayBindings,
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      ok: false,
      error: {
        code: "WORKSPACE_ROUTE_INVALID",
        message: "The workspace route is invalid",
      },
    });
  });

  it("separates control and regional DataFn resources", async () => {
    const request = (body: unknown) =>
      new Request("https://app.skillplane.dev/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });

    await expect(
      classifyDatafnAuthority(request({ resource: "workspaces" })),
    ).resolves.toBe("control");
    await expect(
      classifyDatafnAuthority(request({ resource: "skills" })),
    ).resolves.toBe("regional");
    await expect(
      classifyDatafnAuthority(
        request({ resources: ["workspaceMemberships", "skills"] }),
      ),
    ).resolves.toBe("mixed");
    await expect(
      classifyDatafnAuthority(
        request({
          resource: "skills",
          filters: { metadata: { resource: "workspaces" } },
        }),
      ),
    ).resolves.toBe("regional");
  });

  it("authenticates a headerless regional DataFn request before route lookup", async () => {
    const routed = createRoutedApiApplication({
      local: { fetch: async () => new Response("unexpected local response") },
      services: async () =>
        ({
          auth: { provider: { authenticate: async () => null } },
        }) as never,
    });

    const response = await routed.fetch(
      new Request("http://localhost:5700/datafn/query", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          resource: "skills",
          version: 1,
          select: ["id"],
          limit: 1,
        }),
      }),
      gatewayBindings,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTHENTICATION_REQUIRED" },
    });
  });

  it("terminates anonymous public-by-ID reads at the global projection", async () => {
    const local = { fetch: async () => new Response("global projection") };
    const services = async () =>
      ({ auth: { provider: { authenticate: async () => null } } }) as never;
    const routed = createRoutedApiApplication({ local, services });

    const response = await routed.fetch(
      new Request("http://localhost:5700/api/v1/skills/skill%3Apublic"),
      gatewayBindings,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("global projection");
  });

  it("routes authenticated public-by-ID reads to the owning cell", async () => {
    const query = async (text: string) => {
      if (text.includes("FROM resource_routing_directory")) {
        return {
          rows: [
            {
              resource_type: "skill",
              resource_id: "skill:public",
              workspace_id: "workspace:one",
              state: "active",
              updated_at: new Date("2026-07-26T00:00:00.000Z"),
            },
          ],
        };
      }
      if (text.includes("FROM workspace_memberships")) {
        return { rows: [{ present: 1 }] };
      }
      if (text.includes("FROM workspace_placements")) {
        return {
          rows: [
            {
              workspace_id: "workspace:one",
              region_id: "in-south",
              epoch: 1,
              state: "active",
              updated_at: new Date("2026-07-26T00:00:00.000Z"),
              cache_expires_at: null,
              destination_ref: null,
              moving_to_region_id: null,
              previous_region_id: null,
              migration: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL in routing test: ${text}`);
    };
    const services = async () =>
      ({
        auth: {
          provider: {
            authenticate: async () => ({ actorId: "user:one" }),
          },
        },
        controlDatabase: { pool: { query } },
      }) as never;
    const routed = createRoutedApiApplication({
      local: { fetch: async () => new Response("unexpected global response") },
      services,
    });

    const response = await routed.fetch(
      new Request("http://localhost:5700/api/v1/skills/skill%3Apublic"),
      {
        ...gatewayBindings,
        CELL_APP: {
          fetch: async (request: Request) =>
            Response.json({
              routedWorkspace: request.headers.get("x-skillplane-routed-workspace-id"),
              hasAssertion: Boolean(request.headers.get("x-datafn-routing-assertion")),
            }),
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      routedWorkspace: "workspace:one",
      hasAssertion: true,
    });
  });

  it("uses the public projection for authenticated non-members", async () => {
    const query = async (text: string) => {
      if (text.includes("FROM resource_routing_directory")) {
        return {
          rows: [
            {
              resource_type: "skill",
              resource_id: "skill:public",
              workspace_id: "workspace:one",
              state: "active",
              updated_at: new Date("2026-07-26T00:00:00.000Z"),
            },
          ],
        };
      }
      if (text.includes("FROM workspace_memberships")) return { rows: [] };
      throw new Error(`Unexpected SQL in routing test: ${text}`);
    };
    const routed = createRoutedApiApplication({
      local: { fetch: async () => new Response("global public projection") },
      services: async () =>
        ({
          auth: {
            provider: {
              authenticate: async () => ({ actorId: "user:outsider" }),
            },
          },
          controlDatabase: { pool: { query } },
        }) as never,
    });

    const response = await routed.fetch(
      new Request("http://localhost:5700/api/v1/skills/skill%3Apublic"),
      gatewayBindings,
    );

    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("global public projection");
  });

  it.each([
    ["anonymous callers", null],
    ["authenticated non-members", { actorId: "user:outsider" }],
  ])(
    "routes nested public skill reads for %s to the owning cell",
    async (_case, session) => {
      const query = async (text: string) => {
        if (text.includes("FROM resource_routing_directory")) {
          return {
            rows: [
              {
                resource_type: "skill",
                resource_id: "skill:public",
                workspace_id: "workspace:one",
                state: "active",
                updated_at: new Date("2026-07-26T00:00:00.000Z"),
              },
            ],
          };
        }
        if (text.includes("FROM workspace_memberships")) return { rows: [] };
        if (text.includes("FROM workspace_placements")) {
          return {
            rows: [
              {
                workspace_id: "workspace:one",
                region_id: "in-south",
                epoch: 1,
                state: "active",
                updated_at: new Date("2026-07-26T00:00:00.000Z"),
                cache_expires_at: null,
                destination_ref: null,
                moving_to_region_id: null,
                previous_region_id: null,
                migration: null,
              },
            ],
          };
        }
        throw new Error(`Unexpected SQL in routing test: ${text}`);
      };
      const routed = createRoutedApiApplication({
        local: { fetch: async () => new Response("unexpected global response") },
        services: async () =>
          ({
            auth: { provider: { authenticate: async () => session } },
            controlDatabase: { pool: { query } },
          }) as never,
      });

      const response = await routed.fetch(
        new Request(
          "http://localhost:5700/api/v1/skills/skill%3Apublic/versions/version%3Aone/bundle",
        ),
        {
          ...gatewayBindings,
          CELL_APP: {
            fetch: async (request: Request) =>
              Response.json({
                workspaceId: request.headers.get("x-skillplane-routed-workspace-id"),
                publicRead: request.headers.get("x-skillplane-public-skill-read"),
              }),
          },
        },
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        workspaceId: "workspace:one",
        publicRead: "1",
      });
    },
  );

  it("keeps nested skill reads private for authenticated workspace members", async () => {
    const query = async (text: string) => {
      if (text.includes("FROM resource_routing_directory")) {
        return {
          rows: [
            {
              resource_type: "skill",
              resource_id: "skill:private",
              workspace_id: "workspace:one",
              state: "active",
              updated_at: new Date("2026-07-26T00:00:00.000Z"),
            },
          ],
        };
      }
      if (text.includes("FROM workspace_memberships")) {
        return { rows: [{ present: 1 }] };
      }
      if (text.includes("FROM workspace_placements")) {
        return {
          rows: [
            {
              workspace_id: "workspace:one",
              region_id: "in-south",
              epoch: 1,
              state: "active",
              updated_at: new Date("2026-07-26T00:00:00.000Z"),
              cache_expires_at: null,
              destination_ref: null,
              moving_to_region_id: null,
              previous_region_id: null,
              migration: null,
            },
          ],
        };
      }
      throw new Error(`Unexpected SQL in routing test: ${text}`);
    };
    const routed = createRoutedApiApplication({
      local: { fetch: async () => new Response("unexpected global response") },
      services: async () =>
        ({
          auth: {
            provider: { authenticate: async () => ({ actorId: "user:one" }) },
          },
          controlDatabase: { pool: { query } },
        }) as never,
    });

    const response = await routed.fetch(
      new Request("http://localhost:5700/api/v1/skills/skill%3Aprivate/versions"),
      {
        ...gatewayBindings,
        CELL_APP: {
          fetch: async (request: Request) =>
            Response.json({
              workspaceId: request.headers.get("x-skillplane-routed-workspace-id"),
              publicRead: request.headers.get("x-skillplane-public-skill-read"),
            }),
        },
      },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      workspaceId: "workspace:one",
      publicRead: null,
    });
  });

  it("boots a private cell without gateway-only OTP or email bindings", async () => {
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
