import type { SkillsListOutput, SkillsSearchOutput } from "@skillplane/mcp-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prepareMcpProtocolRequest,
  projectMcpToolCatalogResponse,
} from "../../src/index.js";
import type { McpIdentity } from "../../src/auth.js";
import { SKILLPLANE_MCP_SERVER_INFO } from "../../src/server.js";
import {
  parseStructured,
  startMcpTestEnvironment,
  TEST_CALLER,
  TEST_MCP_RESOURCE,
  type ConnectedMcpClient,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";

let environment: McpTestEnvironment;
let connection: ConnectedMcpClient;

beforeAll(async () => {
  environment = await startMcpTestEnvironment("conformance");
  connection = await environment.connect(environment.serviceToken);
}, 60_000);

afterAll(async () => {
  await environment.close();
}, 30_000);

function protocolRequest(
  body: string,
  headers: Record<string, string> = {},
  method = "POST",
): Promise<Response> {
  return environment.app.fetch(
    new Request(TEST_MCP_RESOURCE, {
      method,
      headers: {
        authorization: `Bearer ${environment.serviceToken}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        ...headers,
      },
      body,
    }),
  );
}

function oauthIdentity(clientId: string): McpIdentity {
  return {
    kind: "oauth",
    actorType: "user",
    actorId: "user:test",
    userId: "user:test",
    credentialId: "oauth-token:test",
    credentialKind: "oauth_access_token",
    clientId,
    scopes: ["skills:read"],
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };
}

const SERVICE_IDENTITY: McpIdentity = {
  kind: "service",
  actorType: "service_principal",
  actorId: "service:test",
  servicePrincipalId: "service:test",
  userId: null,
  credentialId: "service-token:test",
  credentialKind: "service_principal",
  workspaceId: "workspace:test",
  displayName: "Test service",
  role: "viewer",
  scopes: ["skills:read"],
};

function toolCatalogResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), {
    headers: { "content-type": "application/json" },
  });
}

describe("MCP Streamable HTTP conformance", () => {
  it("negotiates a supported protocol and completes initialize, initialized, and ping", async () => {
    expect(connection.transport.protocolVersion).toBe("2025-11-25");
    expect(connection.transport.sessionId).toBeUndefined();
    expect(connection.client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
    });
    expect(connection.client.getServerVersion()).toEqual(SKILLPLANE_MCP_SERVER_INFO);
    await expect(connection.client.ping()).resolves.toEqual({});
  });

  it("advertises twenty-seven complete tool contracts as JSON Schema", async () => {
    const result = await connection.client.listTools();
    expect(result.tools).toHaveLength(27);
    for (const tool of result.tools) {
      expect(tool.name).toMatch(
        /^(workspaces_list|skills_list|skills_search|skill_retrieve|skill_asset_retrieve|skill_versions_list|skill_versions_diff|skill_candidates_list|skill_amendment_policy_get|contexts_list|context_get|context_knowledge_history|context_notes_list|skill_amend|skill_create|skill_visibility_update|skill_archive|skill_restore|skill_candidate_approve|skill_candidate_reject|skill_amendment_policy_update|context_create|context_update|context_archive|context_restore|context_knowledge_update|context_note_upsert)$/u,
      );
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      const mutating = [
        "skill_amend",
        "skill_create",
        "skill_visibility_update",
        "skill_archive",
        "skill_restore",
        "skill_candidate_approve",
        "skill_candidate_reject",
        "skill_amendment_policy_update",
        "context_create",
        "context_update",
        "context_archive",
        "context_restore",
        "context_knowledge_update",
        "context_note_upsert",
      ].includes(tool.name);
      expect(tool.annotations).toEqual({
        readOnlyHint: !mutating,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
    }
  });

  it("keeps Linear's complete tool inventory below its catalog budget", async () => {
    const listed = await connection.client.listTools();
    const response = await projectMcpToolCatalogResponse(
      toolCatalogResponse(listed),
      oauthIdentity("https://linear.app/.well-known/oauth-client-metadata/mcp.json"),
    );
    const body = await response.text();
    const compacted = JSON.parse(body) as {
      readonly result: { readonly tools: readonly Record<string, unknown>[] };
    };

    expect(Buffer.byteLength(body)).toBeLessThan(32 * 1_024);
    expect(compacted.result.tools).toHaveLength(27);
    for (const tool of compacted.result.tools) {
      expect(tool).not.toHaveProperty("outputSchema");
      expect(tool).not.toHaveProperty("execution");
      expect(tool).not.toHaveProperty("annotations");
      expect(tool).not.toHaveProperty("title");
      expect(tool.inputSchema).not.toHaveProperty("$schema");
      expect(tool.inputSchema).not.toHaveProperty("properties.caller");
      expect(tool.inputSchema).not.toHaveProperty(
        "required",
        expect.arrayContaining(["caller"]),
      );
      expect(tool.inputSchema).not.toHaveProperty("required", []);
    }
  });

  it("hides caller from Claude and generic OAuth catalogs without compacting metadata", async () => {
    const listed = await connection.client.listTools();
    for (const clientId of [
      "https://claude.ai/oauth/mcp-oauth-client-metadata",
      "https://agent.example.test/oauth/client",
    ]) {
      const response = await projectMcpToolCatalogResponse(
        toolCatalogResponse(listed),
        oauthIdentity(clientId),
      );
      const projected = (await response.json()) as {
        readonly result: {
          readonly tools: readonly Record<string, unknown>[];
        };
      };
      for (const tool of projected.result.tools) {
        expect(tool).toHaveProperty("outputSchema");
        expect(tool).toHaveProperty("annotations");
        expect(tool.inputSchema).not.toHaveProperty("properties.caller");
        expect(tool.inputSchema).not.toHaveProperty(
          "required",
          expect.arrayContaining(["caller"]),
        );
        expect(tool.inputSchema).not.toHaveProperty("required", []);
        expect(tool.inputSchema).toHaveProperty("additionalProperties", false);
      }
    }
  });

  it("keeps caller model-visible and caller-required for service principals", async () => {
    const listed = await connection.client.listTools();
    const response = await projectMcpToolCatalogResponse(
      toolCatalogResponse(listed),
      SERVICE_IDENTITY,
    );
    const canonical = (await response.json()) as {
      readonly result: {
        readonly tools: readonly Record<string, unknown>[];
      };
    };
    for (const tool of canonical.result.tools) {
      expect(tool.inputSchema).toHaveProperty("properties.caller");
      expect(tool.inputSchema).toHaveProperty(
        "required",
        expect.arrayContaining(["caller"]),
      );
      expect(tool.inputSchema).toHaveProperty("additionalProperties", false);
    }
  });

  it("injects bounded caller attribution for known and generic OAuth profiles", async () => {
    const profiles = [
      {
        clientId: "https://claude.ai/oauth/mcp-oauth-client-metadata",
        caller: {
          agentId: "claude",
          agentName: "Claude",
          modelProvider: "Anthropic",
          clientName: "Claude",
        },
        runPrefix: "claude-run:",
      },
      {
        clientId: "https://linear.app/.well-known/oauth-client-metadata/mcp.json",
        caller: {
          agentId: "linear-agent",
          agentName: "Linear Agent",
          modelProvider: "Linear",
          clientName: "Linear",
        },
        runPrefix: "linear-run:",
      },
      {
        clientId: "https://agent.example.test/oauth/client",
        caller: {
          agentId: "authenticated-oauth-client",
          agentName: "Authenticated OAuth client",
          modelProvider: "unknown",
          clientName: "OAuth MCP client",
        },
        runPrefix: "oauth-client-run:",
      },
    ] as const;

    for (const profile of profiles) {
      const request = await prepareMcpProtocolRequest(
        new Request(TEST_MCP_RESOURCE, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/call",
            params: {
              name: "skills_list",
              arguments: {
                workspaceId: "workspace:test",
                caller: { agentId: "forged" },
              },
            },
          }),
        }),
        oauthIdentity(profile.clientId),
      );
      const payload = (await request.json()) as {
        readonly params: {
          readonly arguments: {
            readonly workspace: { readonly id: string };
            readonly workspaceId?: string;
            readonly caller: Record<string, unknown>;
          };
        };
      };

      expect(payload.params.arguments.workspace).toEqual({ id: "workspace:test" });
      expect(payload.params.arguments).not.toHaveProperty("workspaceId");
      expect(payload.params.arguments.caller).toMatchObject(profile.caller);
      expect(payload.params.arguments.caller.runId).toMatch(
        new RegExp(`^${profile.runPrefix}`, "u"),
      );
      expect(payload.params.arguments.caller).not.toHaveProperty("agentId", "forged");
    }
  });

  it("does not adapt service-principal calls or ambiguous workspace selectors", async () => {
    const serviceRequest = new Request(TEST_MCP_RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: {
          name: "skills_list",
          arguments: { workspaceId: "workspace:test" },
        },
      }),
    });
    await expect(
      prepareMcpProtocolRequest(serviceRequest, SERVICE_IDENTITY),
    ).resolves.toBe(serviceRequest);

    const ambiguous = await prepareMcpProtocolRequest(
      new Request(TEST_MCP_RESOURCE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: {
            name: "skills_list",
            arguments: {
              workspace: { id: "workspace:canonical" },
              workspaceId: "workspace:legacy",
            },
          },
        }),
      }),
      oauthIdentity("https://agent.example.test/oauth/client"),
    );
    const payload = (await ambiguous.json()) as {
      readonly params: { readonly arguments: Record<string, unknown> };
    };
    expect(payload.params.arguments).toMatchObject({
      workspace: { id: "workspace:canonical" },
      workspaceId: "workspace:legacy",
    });
  });

  it("executes the original OAuth listing shape and rejects the malformed alias", async () => {
    const oauthToken = await environment.issueOAuthToken("skills:read");
    const oauthConnection = await environment.connect(oauthToken);
    const listed = await oauthConnection.client.listTools();
    const listingTool = listed.tools.find((tool) => tool.name === "skills_list");
    expect(listingTool?.inputSchema).not.toHaveProperty("properties.caller");
    expect(listingTool?.inputSchema).toHaveProperty("additionalProperties", false);

    const result = await oauthConnection.client.callTool({
      name: "skills_list",
      arguments: {
        workspaceId: environment.owner.workspaceId,
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = parseStructured<SkillsListOutput>(result);
    expect(structured.workspace.id).toBe(environment.owner.workspaceId);
    expect(structured.skills.map((skill) => skill.id)).toContain(
      environment.skill.skill.id,
    );

    const malformed = await oauthConnection.client.callTool({
      name: "skills_list",
      arguments: {
        workspace_id: environment.owner.workspaceId,
      },
    });
    expect(malformed.isError).toBe(true);
  });

  it("executes a declared tool through structured and text MCP content", async () => {
    const result = await connection.client.callTool({
      name: "skills_search",
      arguments: {
        query: "authorization",
        workspaceId: environment.owner.workspaceId,
        visibility: ["public"],
        tags: ["review"],
        limit: 20,
        caller: TEST_CALLER,
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = parseStructured<SkillsSearchOutput>(result);
    expect(structured.skills[0]).toMatchObject({
      id: environment.skill.skill.id,
      currentVersion: {
        id: environment.skill.version.id,
        digest: environment.skill.version.digest,
      },
    });
    const text = result.content.find((item) => item.type === "text");
    expect(text?.type === "text" ? JSON.parse(text.text) : null).toEqual(structured);
  });

  it("enforces Streamable HTTP content negotiation and media type requirements", async () => {
    const ping = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    const unacceptable = await protocolRequest(ping, {
      accept: "application/json",
    });
    expect(unacceptable.status).toBe(406);
    await expect(unacceptable.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });

    const unsupportedMedia = await protocolRequest(ping, {
      "content-type": "text/plain",
    });
    expect(unsupportedMedia.status).toBe(415);
    await expect(unsupportedMedia.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });

    const malformed = await protocolRequest("{");
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32700 },
    });
  });

  it("rejects unsupported negotiated versions and unsupported methods safely", async () => {
    const ping = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "ping",
    });
    const version = await protocolRequest(ping, {
      "mcp-protocol-version": "1900-01-01",
    });
    expect(version.status).toBe(400);
    await expect(version.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });

    const method = await protocolRequest(ping, {}, "PUT");
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("POST");
    await expect(method.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });
  });

  it("declines standalone SSE streams immediately on the stateless endpoint", async () => {
    const response = await environment.app.fetch(
      new Request(TEST_MCP_RESOURCE, {
        method: "GET",
        headers: {
          authorization: `Bearer ${environment.serviceToken}`,
          accept: "text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
      }),
    );

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      jsonrpc: "2.0",
      error: {
        code: -32000,
        message: "Method not allowed.",
      },
      id: null,
    });
  });
});
