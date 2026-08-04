import type { SkillsSearchOutput } from "@skillplane/mcp-schema";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    expect(result.isError).not.toBe(true);
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
    expect(method.headers.get("allow")).toBe("GET, POST");
    await expect(method.json()).resolves.toMatchObject({
      jsonrpc: "2.0",
      error: { code: -32000 },
    });
  });

  it("keeps standalone SSE streams alive with an immediate heartbeat", async () => {
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

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toBe("no-store");
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();
    const first = await reader?.read();
    expect(new TextDecoder().decode(first?.value)).toBe(": skillplane heartbeat\n\n");
    expect(first?.done).toBe(false);
    await reader?.cancel();
  });
});
