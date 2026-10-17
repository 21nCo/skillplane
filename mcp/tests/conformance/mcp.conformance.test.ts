import type { SkillsListOutput, SkillsSearchOutput } from "@skillplane/mcp-schema";
import type { PostHog } from "@posthog/mcp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { isPostHogSessionId } from "../../src/analytics.js";
import incident from "../fixtures/oauth-list-skills-incident.json" with { type: "json" };
import { OAUTH_CLIENT_PROFILES } from "../../src/client-profiles.js";
import {
  SKILLPLANE_MCP_SERVER_INFO,
  skillplaneMcpDeclaration,
} from "../../src/server.js";
import {
  SKILLPLANE_MCP_TOOL_COUNT,
  SKILLPLANE_MCP_TOOL_NAMES,
} from "../../src/tool-catalog.js";
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
  const posthog = {
    capture: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as PostHog;
  environment = await startMcpTestEnvironment("conformance", { posthog });
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

function incidentArguments(workspaceId: string): Record<string, unknown> {
  return JSON.parse(
    JSON.stringify(incident.rejectedArguments).replaceAll(
      incident.redactedWorkspaceId,
      workspaceId,
    ),
  ) as Record<string, unknown>;
}

async function auditedCaller(requestId: string): Promise<Record<string, unknown>> {
  const result = await environment.services.database.pool.query<{
    readonly metadata: { readonly caller: Record<string, unknown> };
  }>("SELECT metadata FROM audit_events WHERE request_id = $1", [requestId]);
  expect(result.rows).toHaveLength(1);
  return result.rows[0]?.metadata.caller ?? {};
}

async function ownerWorkspaceSlug(): Promise<string> {
  const result = await environment.services.database.pool.query<{
    readonly slug: string;
  }>("SELECT slug FROM workspaces WHERE id = $1", [environment.owner.workspaceId]);
  const slug = result.rows[0]?.slug;
  if (!slug) throw new Error("The owner workspace slug is missing");
  return slug;
}

describe("MCP Streamable HTTP conformance", () => {
  it("negotiates a supported protocol and completes initialize, initialized, and ping", async () => {
    expect(connection.transport.protocolVersion).toBe("2025-11-25");
    expect(isPostHogSessionId(connection.transport.sessionId ?? "")).toBe(true);
    expect(connection.client.getServerCapabilities()).toMatchObject({
      tools: { listChanged: true },
    });
    expect(connection.client.getServerVersion()).toEqual(SKILLPLANE_MCP_SERVER_INFO);
    await expect(connection.client.ping()).resolves.toEqual({});
  });

  it("advertises the live registered tool contracts as JSON Schema", async () => {
    const result = await connection.client.listTools();
    const declaredByName = new Map(
      skillplaneMcpDeclaration.registry.definitions().map((tool) => [tool.name, tool]),
    );
    expect(result.tools).toHaveLength(SKILLPLANE_MCP_TOOL_COUNT);
    expect(result.tools.map((tool) => tool.name).toSorted()).toEqual([
      ...SKILLPLANE_MCP_TOOL_NAMES,
    ]);
    for (const tool of result.tools) {
      const declared = declaredByName.get(tool.name);
      expect(declared).toBeDefined();
      expect(tool.description?.length).toBeGreaterThan(40);
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.inputSchema).not.toHaveProperty(
        "properties.context.description",
        expect.stringContaining("analytics and user intent tracking"),
      );
      expect(tool.outputSchema).toMatchObject({ type: "object" });
      expect(tool.annotations).toEqual(declared?.annotations);
    }
  });

  it("keeps caller model-visible and caller-required for service principals", async () => {
    const listed = await connection.client.listTools();
    for (const tool of listed.tools) {
      expect(tool.inputSchema).toHaveProperty("properties.caller");
      expect(tool.inputSchema).toHaveProperty(
        "required",
        expect.arrayContaining(["caller"]),
      );
      expect(tool.inputSchema).toHaveProperty("additionalProperties", false);
    }
  });

  it("executes the original OAuth listing incident and names a malformed selector", async () => {
    const oauthToken = await environment.issueOAuthToken("skills:read");
    const oauthConnection = await environment.connect(oauthToken);
    const listed = await oauthConnection.client.listTools();
    for (const tool of listed.tools) {
      expect(tool.inputSchema).not.toHaveProperty("properties.caller");
      expect(tool.inputSchema.required ?? []).not.toContain("caller");
      expect(tool.inputSchema).toHaveProperty("additionalProperties", false);
    }

    const result = await oauthConnection.client.callTool({
      name: incident.tool,
      arguments: incidentArguments(environment.owner.workspaceId),
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const structured = parseStructured<SkillsListOutput>(result);
    expect(structured.workspace.id).toBe(environment.owner.workspaceId);
    expect(structured.skills.map((skill) => skill.id)).toContain(
      environment.skill.skill.id,
    );

    const malformed = await oauthConnection.client.callTool({
      name: "skills_list",
      arguments: { workspace_id: environment.owner.workspaceId },
    });
    expect(malformed.isError).toBe(true);
    const text = malformed.content.find((item) => item.type === "text");
    const body = text?.type === "text" ? text.text : "";
    expect(body).not.toContain(environment.owner.workspaceId);
    expect(JSON.parse(body)).toMatchObject({
      error: {
        code: "MCPFN_INVALID_ARGUMENTS",
        details: {
          lifecycleStage: "input-validation",
          profile: { id: "skillplane/oauth-generic", version: "1" },
          issues: expect.arrayContaining([
            expect.objectContaining({
              keyword: "additionalProperties",
              instancePath: "/",
              rejectedProperty: "workspace_id",
            }),
          ]),
        },
      },
    });
  });

  it("records only profile-derived attribution for a forged OAuth caller", async () => {
    const oauthToken = await environment.issueOAuthToken("skills:read");
    const oauthConnection = await environment.connect(oauthToken);
    const result = await oauthConnection.client.callTool({
      name: "skills_list",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        caller: { ...TEST_CALLER, agentId: "forged-agent", agentName: "Forged" },
      },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const caller = await auditedCaller(
      parseStructured<SkillsListOutput>(result).requestId,
    );
    // Every supplied field is discarded: the record is exactly the generic
    // profile's attribution, one fresh per-invocation ID and the audit
    // writer's existing trust label.
    const invocation = String(caller.runId).replace(/^oauth-client-run:/u, "");
    expect(invocation).toMatch(/^[0-9a-f-]{36}$/u);
    expect(caller).toEqual({
      ...OAUTH_CLIENT_PROFILES.generic.caller,
      runId: `oauth-client-run:${invocation}`,
      sessionId: `oauth-client-session:${invocation}`,
      conversationId: `oauth-client-conversation:${invocation}`,
      trust: "caller-declared",
    });
  });

  it("searches with either nested workspace selector or the deprecated flat alias", async () => {
    for (const selector of [
      { workspace: { id: environment.owner.workspaceId } },
      { workspace: { slug: await ownerWorkspaceSlug() } },
      { workspaceId: environment.owner.workspaceId },
    ]) {
      const result = await connection.client.callTool({
        name: "skills_search",
        arguments: {
          query: "authorization",
          ...selector,
          visibility: ["public"],
          caller: TEST_CALLER,
        },
      });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      expect(
        parseStructured<SkillsSearchOutput>(result).skills.map((skill) => skill.id),
      ).toContain(environment.skill.skill.id);
    }
    const ambiguous = await connection.client.callTool({
      name: "skills_search",
      arguments: {
        query: "authorization",
        workspace: { id: environment.owner.workspaceId },
        workspaceId: environment.owner.workspaceId,
        caller: TEST_CALLER,
      },
    });
    expect(ambiguous.isError).toBe(true);
  });

  it("executes a declared tool through structured and text MCP content", async () => {
    const result = await connection.client.callTool({
      name: "skills_search",
      arguments: {
        query: "authorization",
        workspace: { id: environment.owner.workspaceId },
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
