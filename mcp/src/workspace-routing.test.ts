import { McpToolError } from "@skillplane/mcp-schema";
import { describe, expect, it } from "vitest";
import {
  authorizeMcpWorkspace,
  classifyMcpScope,
  createRoutedMcpApplication,
  resolveMcpWorkspaceBatch,
} from "./workspace-routing.js";

function call(name: string, arguments_: Record<string, unknown> = {}) {
  return new Request("https://mcp.skillplane.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: arguments_ },
    }),
  });
}

function batch(...calls: { readonly name: string; readonly arguments: object }[]) {
  return new Request("https://mcp.skillplane.dev/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      calls.map((entry, index) => ({
        jsonrpc: "2.0",
        id: index + 1,
        method: "tools/call",
        params: entry,
      })),
    ),
  });
}

function services(routes: Readonly<Record<string, string>>) {
  return {
    controlDatabase: {
      pool: {
        query: async (_text: string, values: readonly unknown[]) => ({
          rows: [
            {
              resource_type: "skill",
              resource_id: values[1],
              workspace_id: routes[String(values[1])],
              state: "active",
              updated_at: new Date("2026-08-30T00:00:00.000Z"),
            },
          ],
        }),
      },
    },
  } as never;
}

function localBindings() {
  const storage = {
    head: async () => null,
    get: async () => null,
    put: async () => null,
    delete: async () => undefined,
    list: async () => ({ objects: [] }),
  };
  return {
    RUNTIME_ENV: "local",
    SKILLPLANE_ROLE: "control",
    SKILLPLANE_TOPOLOGY: JSON.stringify({
      version: 1,
      mode: "multi-cell",
      public: {
        appAuthority: "https://app.skillplane.dev",
        mcpResource: "https://mcp.skillplane.dev/mcp",
      },
      controlPlane: {
        regionId: "global",
        databaseBinding: "CONTROL_HYPERDRIVE",
        publicObjectStorageBinding: "PUBLIC_SKILL_BUNDLES",
        issuer: "https://app.skillplane.dev",
        oauthResource: "https://mcp.skillplane.dev/mcp",
      },
      cells: [
        {
          regionId: "in-south",
          databaseBinding: "CELL_HYPERDRIVE",
          objectStorageBinding: "CELL_SKILL_BUNDLES",
          appServiceBinding: "CELL_APP",
          mcpServiceBinding: "CELL_MCP",
          publiclyRoutable: false,
        },
        {
          regionId: "us-east",
          databaseBinding: "CELL_US_HYPERDRIVE",
          objectStorageBinding: "CELL_US_SKILL_BUNDLES",
          appServiceBinding: "CELL_US_APP",
          mcpServiceBinding: "CELL_US_MCP",
          publiclyRoutable: false,
        },
      ],
      routing: {
        activeKeyId: "current",
        verificationKeyIds: ["current"],
        assertionAudience: "skillplane-cell",
        assertionTtlSeconds: 20,
      },
    }),
    CONTROL_HYPERDRIVE: {
      connectionString: "postgresql://fixture:fixture@localhost:5432/skillplane",
    },
    PUBLIC_SKILL_BUNDLES: storage,
    WORKSPACE_ROUTING_KEYS: JSON.stringify({
      current: "routing-only-secret-material-32-bytes",
    }),
  } as never;
}

describe("MCP workspace routing", () => {
  it("keeps protocol and workspace catalog operations global", async () => {
    await expect(classifyMcpScope(call("workspaces_list"))).resolves.toEqual({
      kind: "global",
    });
  });

  it("routes workspace and skill selectors without exposing cell hosts", async () => {
    await expect(
      classifyMcpScope(call("skills_list", { workspace: { slug: "acme" } })),
    ).resolves.toEqual({
      kind: "workspace-slug",
      value: "acme",
      allowPublic: false,
    });
    await expect(
      classifyMcpScope(
        call("skills_search", { workspace: { id: "workspace:public" } }),
      ),
    ).resolves.toEqual({
      kind: "workspace-id",
      value: "workspace:public",
      allowPublic: true,
    });
    await expect(
      classifyMcpScope(call("skill_retrieve", { skill: { id: "skill:one" } })),
    ).resolves.toEqual({
      kind: "skill-id",
      value: "skill:one",
      allowPublic: true,
    });
    await expect(
      classifyMcpScope(call("skill_amend", { skillId: "skill:one" })),
    ).resolves.toEqual({
      kind: "skill-id",
      value: "skill:one",
      allowPublic: false,
    });
  });

  it("allows authenticated non-members to search a workspace's public skills", async () => {
    const scope = await classifyMcpScope(
      call("skills_search", { workspace: { id: "workspace:public" } }),
    );
    if (scope.kind === "global" || scope.kind === "batch") {
      throw new Error("Expected one workspace scope");
    }
    const query = async () => ({ rows: [] });
    await expect(
      authorizeMcpWorkspace(
        { kind: "oauth", userId: "user:outsider" } as never,
        scope,
        { workspaceId: "workspace:public" },
        { controlDatabase: { pool: { query } } } as never,
      ),
    ).resolves.toBeUndefined();

    const privateScope = await classifyMcpScope(
      call("skills_list", { workspace: { id: "workspace:private" } }),
    );
    if (privateScope.kind === "global" || privateScope.kind === "batch") {
      throw new Error("Expected one workspace scope");
    }
    await expect(
      authorizeMcpWorkspace(
        { kind: "oauth", userId: "user:outsider" } as never,
        privateScope,
        { workspaceId: "workspace:private" },
        { controlDatabase: { pool: { query } } } as never,
      ),
    ).rejects.toMatchObject({ code: "WORKSPACE_ACCESS_DENIED" });
  });

  it("routes credential-bound downloads through the owning cell", async () => {
    await expect(
      classifyMcpScope(
        new Request("https://mcp.skillplane.dev/downloads/signed-grant"),
      ),
    ).resolves.toEqual({
      kind: "download-grant",
      token: "signed-grant",
      allowPublic: true,
    });
  });

  it("rejects mixed-workspace batches", async () => {
    const scope = await classifyMcpScope(
      batch(
        { name: "skill_retrieve", arguments: { skillId: "skill:one" } },
        { name: "skill_retrieve", arguments: { skillId: "skill:two" } },
      ),
    );
    if (scope.kind === "global") throw new Error("Expected a workspace batch");
    await expect(
      resolveMcpWorkspaceBatch(
        scope,
        services({
          "skill:one": "workspace:one",
          "skill:two": "workspace:two",
        }),
      ),
    ).rejects.toMatchObject({
      code: "WORKSPACE_BATCH_INVALID",
    });
  });

  it("accepts different resource selectors that resolve to one workspace", async () => {
    const scope = await classifyMcpScope(
      batch(
        { name: "skill_retrieve", arguments: { skillId: "skill:one" } },
        { name: "skill_versions_list", arguments: { skillId: "skill:two" } },
      ),
    );
    if (scope.kind === "global") throw new Error("Expected a workspace batch");
    await expect(
      resolveMcpWorkspaceBatch(
        scope,
        services({
          "skill:one": "workspace:one",
          "skill:two": "workspace:one",
        }),
      ),
    ).resolves.toMatchObject({ workspaceId: "workspace:one" });
  });

  it("preserves routed MCP tool retryability and details", async () => {
    const app = createRoutedMcpApplication({
      local: {
        fetch() {
          throw new McpToolError("DATABASE_UNAVAILABLE", "Database unavailable", {
            status: 503,
            retryable: true,
            details: { region: "in-south", attempt: 2 },
          });
        },
      },
      services: async () => {
        throw new Error("Services should not be loaded");
      },
    });

    const response = await app.fetch(call("workspaces_list"), localBindings());

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "DATABASE_UNAVAILABLE",
      error_description: "Database unavailable",
      retryable: true,
      details: { region: "in-south", attempt: 2 },
    });
  });

  it.each([
    {
      code: "AUTH_INVALID" as const,
      status: 401 as const,
      oauthError: "invalid_token",
    },
    {
      code: "AUTH_SCOPE_REQUIRED" as const,
      status: 403 as const,
      oauthError: "insufficient_scope",
    },
  ])("preserves routed $code authentication responses", async (expected) => {
    const app = createRoutedMcpApplication({
      local: {
        fetch() {
          throw new McpToolError(expected.code, "Credential rejected", {
            status: expected.status,
          });
        },
      },
      services: async () => {
        throw new Error("Services should not be loaded");
      },
    });

    const response = await app.fetch(call("workspaces_list"), localBindings());

    expect(response.status).toBe(expected.status);
    expect(response.headers.get("www-authenticate")).toContain(expected.oauthError);
    await expect(response.json()).resolves.toEqual({
      error: expected.oauthError,
      error_description: "Credential rejected",
    });
  });
});
