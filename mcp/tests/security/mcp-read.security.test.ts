import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type {
  ContextNotesListOutput,
  ContextsListOutput,
  SkillAssetRetrieveOutput,
  SkillRetrieveOutput,
  SkillsListOutput,
  SkillVersionsListOutput,
  WorkspacesListOutput,
} from "@skillplane/mcp-schema";
import type { UserPrincipal } from "@skillplane/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMcpApp } from "../../src/index.js";
import {
  parseStructured,
  parseToolError,
  startMcpTestEnvironment,
  TEST_CALLER,
  TEST_MCP_RESOURCE,
  type ConnectedMcpClient,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";

let environment: McpTestEnvironment;
let service: ConnectedMcpClient;
let outsider: ConnectedMcpClient;
let skillsOnly: ConnectedMcpClient;
let oauthToken: string;

function toolCall(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function rawToolResult(response: Response): Promise<CallToolResult> {
  const envelope = (await response.json()) as {
    readonly result?: CallToolResult;
    readonly error?: unknown;
  };
  if (!envelope.result) {
    throw new Error(`Expected JSON-RPC tool result: ${JSON.stringify(envelope)}`);
  }
  return envelope.result;
}

beforeAll(async () => {
  environment = await startMcpTestEnvironment("security");
  service = await environment.connect(environment.serviceToken);
  outsider = await environment.connect(environment.outsiderServiceToken);
  skillsOnly = await environment.connect(environment.skillsOnlyToken);
  oauthToken = await environment.issueOAuthToken("skills:read");
}, 60_000);

afterAll(async () => {
  await environment?.close();
}, 30_000);

describe("MCP authentication and protocol security", () => {
  it("challenges unauthenticated standalone SSE requests before opening them", async () => {
    const response = await environment.app.fetch(
      new Request(TEST_MCP_RESOURCE, {
        method: "GET",
        headers: {
          accept: "text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
      }),
    );

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("returns standards challenges for missing, revoked, and insufficient credentials", async () => {
    const missing = await environment.rawMcp(null, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "unauthenticated", version: "1.0.0" },
      },
    });
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("Bearer");
    expect(missing.headers.get("www-authenticate")).toContain("resource_metadata=");
    expect(missing.headers.get("cache-control")).toBe("no-store");

    const revoked = await environment.rawMcp(environment.revokedServiceToken, {
      jsonrpc: "2.0",
      id: 2,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "revoked", version: "1.0.0" },
      },
    });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain(environment.revokedServiceToken);

    const insufficient = await environment.rawMcp(
      environment.skillsOnlyToken,
      toolCall("context_get", {
        skill: { id: environment.skill.skill.id },
        context: { id: environment.skill.context.context.id },
        caller: TEST_CALLER,
      }),
    );
    expect(insufficient.status).toBe(403);
    expect(insufficient.headers.get("www-authenticate")).toContain(
      "insufficient_scope",
    );
    expect(insufficient.headers.get("www-authenticate")).toContain(
      'scope="contexts:read"',
    );
  });

  it("rejects a resource-mismatched OAuth token and bearer query parameters", async () => {
    const wrongAudience = await environment.issueOAuthToken();
    await environment.services.database.pool.query(
      `UPDATE authfn_oauth_access_tokens
          SET resource = 'https://other.example.test/mcp'
        WHERE id = (
          SELECT id
            FROM authfn_oauth_access_tokens
           WHERE user_id = $1
           ORDER BY created_at DESC, id DESC
           LIMIT 1
        )`,
      [environment.owner.userId],
    );
    const mismatched = await environment.rawMcp(wrongAudience, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "wrong-audience", version: "1.0.0" },
      },
    });
    expect(mismatched.status).toBe(401);
    expect(await mismatched.text()).not.toContain("other.example.test");

    const queryBearer = await environment.app.fetch(
      new Request(
        `${TEST_MCP_RESOURCE}?access_token=${encodeURIComponent(
          environment.serviceToken,
        )}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "ping",
          }),
        },
      ),
    );
    expect(queryBearer.status).toBe(401);
    expect(await queryBearer.text()).not.toContain(environment.serviceToken);
  });

  it("rejects stale stateful session headers on the stateless endpoint", async () => {
    const response = await environment.app.fetch(
      new Request(TEST_MCP_RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${environment.serviceToken}`,
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
          "mcp-session-id": "stale-attacker-controlled-session",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "ping",
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_session",
    });
  });
});

describe("MCP caller and tenant boundaries", () => {
  it("limits discovery and queryless enumeration to authenticated workspace access", async () => {
    const outsiderWorkspaces = parseStructured<WorkspacesListOutput>(
      await outsider.client.callTool({
        name: "workspaces_list",
        arguments: { caller: TEST_CALLER },
      }),
    );
    expect(outsiderWorkspaces.workspaces.map((workspace) => workspace.id)).toEqual([
      environment.outsider.workspaceId,
    ]);

    const denied = await outsider.client.callTool({
      name: "skills_list",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(denied).error.code).toBe("WORKSPACE_FORBIDDEN");
    expect(JSON.stringify(denied)).not.toContain(environment.privateSkill.skill.name);
  });

  it("rejects incomplete or identity-selecting caller declarations before any R2 read", async () => {
    const readsBefore = environment.storage.getCalls;
    const missingModelVersion = { ...TEST_CALLER } as Record<string, unknown>;
    delete missingModelVersion.modelVersion;
    const incomplete = await service.client.callTool({
      name: "skill_retrieve",
      arguments: {
        skill: { id: environment.privateSkill.skill.id },
        version: { selector: "current" },
        caller: missingModelVersion,
      },
    });
    expect(incomplete.isError).toBe(true);
    expect(JSON.stringify(incomplete)).toContain("Input validation error");
    const identitySelecting = await service.client.callTool({
      name: "skill_retrieve",
      arguments: {
        skill: { id: environment.privateSkill.skill.id },
        version: { selector: "current" },
        caller: {
          ...TEST_CALLER,
          userId: environment.outsider.userId,
        },
      },
    });
    expect(identitySelecting.isError).toBe(true);
    expect(JSON.stringify(identitySelecting)).toContain("unrecognized_keys");
    expect(JSON.stringify(identitySelecting)).toContain("userId");
    expect(environment.storage.getCalls).toBe(readsBefore);
  });

  it("allows cross-workspace public reads but conceals private skills and all contexts", async () => {
    const publicSkill = parseStructured<SkillRetrieveOutput>(
      await outsider.client.callTool({
        name: "skill_retrieve",
        arguments: {
          skill: { id: environment.skill.skill.id },
          version: { selector: "current" },
          caller: TEST_CALLER,
        },
      }),
    );
    expect(publicSkill.skill.id).toBe(environment.skill.skill.id);
    expect(publicSkill.instructions).toBe(environment.skill.markdown);

    const privateResult = await outsider.client.callTool({
      name: "skill_retrieve",
      arguments: {
        skill: { id: environment.privateSkill.skill.id },
        version: { selector: "current" },
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(privateResult).error.code).toBe("SKILL_NOT_FOUND");
    expect(JSON.stringify(privateResult)).not.toContain("Never disclose this fixture");

    const contextResult = await outsider.client.callTool({
      name: "context_get",
      arguments: {
        skill: { id: environment.skill.skill.id },
        context: { id: environment.skill.context.context.id },
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(contextResult).error.code).toBe("SKILL_NOT_FOUND");
    expect(JSON.stringify(contextResult)).not.toContain(
      environment.skill.context.knowledge.body,
    );
  });

  it("limits viewer service credentials to published version history", async () => {
    const history = parseStructured<SkillVersionsListOutput>(
      await skillsOnly.client.callTool({
        name: "skill_versions_list",
        arguments: {
          skill: { id: environment.skill.skill.id },
          states: ["published", "pending_review", "rejected"],
          limit: 100,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(history.versions.map((version) => version.id)).toEqual([
      environment.skill.version.id,
    ]);
    expect(JSON.stringify(history)).not.toContain(environment.skill.candidate.id);

    const candidates = await skillsOnly.client.callTool({
      name: "skill_candidates_list",
      arguments: {
        skill: { id: environment.skill.skill.id },
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(candidates).error.code).toBe("WORKSPACE_FORBIDDEN");
  });

  it("conceals private skill lifecycle reads across workspaces", async () => {
    for (const [name, arguments_] of [
      [
        "skill_versions_diff",
        {
          skill: { id: environment.privateSkill.skill.id },
          fromVersionId: environment.privateSkill.version.id,
          toVersionId: environment.privateSkill.version.id,
          caller: TEST_CALLER,
        },
      ],
      [
        "skill_amendment_policy_get",
        { skill: { id: environment.privateSkill.skill.id }, caller: TEST_CALLER },
      ],
      [
        "skill_candidates_list",
        { skill: { id: environment.privateSkill.skill.id }, caller: TEST_CALLER },
      ],
    ] as const) {
      const result = await outsider.client.callTool({
        name,
        arguments: arguments_,
      });
      expect(parseToolError(result).error.code).toBe("SKILL_NOT_FOUND");
      expect(JSON.stringify(result)).not.toContain(environment.privateSkill.skill.name);
    }
  });
});

describe("MCP content and pagination defenses", () => {
  it("binds context discovery cursors to the skill and state filters", async () => {
    const owner: UserPrincipal = {
      kind: "user",
      actorId: environment.owner.userId,
      userId: environment.owner.userId,
      sessionId: "mcp-context-cursor-fixture",
      workspaceId: environment.owner.workspaceId,
      role: "owner",
    };
    await environment.services.contextService.create({
      skillId: environment.skill.skill.id,
      principal: owner,
      slug: `cursor-${crypto.randomUUID().slice(0, 8)}`,
      name: "Cursor binding context",
      type: "custom",
      initialKnowledge: "Cursor binding knowledge.",
      idempotencyKey: "context-cursor-binding",
      requestId: "fixture:context-cursor-binding",
    });
    const first = parseStructured<ContextsListOutput>(
      await service.client.callTool({
        name: "contexts_list",
        arguments: {
          skill: { id: environment.skill.skill.id },
          state: "all",
          limit: 1,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const mismatch = await service.client.callTool({
      name: "contexts_list",
      arguments: {
        skill: { id: environment.skill.skill.id },
        state: "active",
        limit: 1,
        cursor: first.nextCursor,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(mismatch).error.code).toBe("CURSOR_FILTER_MISMATCH");
  });

  it("binds queryless skill cursors to workspace and filters", async () => {
    const first = parseStructured<SkillsListOutput>(
      await service.client.callTool({
        name: "skills_list",
        arguments: {
          workspace: { id: environment.owner.workspaceId },
          visibility: ["private", "public"],
          limit: 1,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const mismatch = await service.client.callTool({
      name: "skills_list",
      arguments: {
        workspace: { id: environment.owner.workspaceId },
        visibility: ["public"],
        limit: 1,
        cursor: first.nextCursor,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(mismatch).error.code).toBe("CURSOR_FILTER_MISMATCH");
  });

  it.each(["../secret.txt", "/etc/passwd", "references\\checklist.md"])(
    "rejects unsafe asset path %s before reading R2",
    async (path) => {
      const readsBefore = environment.storage.getCalls;
      const result = await service.client.callTool({
        name: "skill_asset_retrieve",
        arguments: {
          skill: { id: environment.skill.skill.id },
          version: { selector: "current" },
          path,
          responseMode: "auto",
          caller: TEST_CALLER,
        },
      });
      expect(parseToolError(result).error.code).toBe("SKILL_PATH_INVALID");
      expect(environment.storage.getCalls).toBe(readsBefore);
    },
  );

  it("returns a typed R2 failure without substituting content or provider details", async () => {
    environment.storage.failReads = true;
    const result = await service.client.callTool({
      name: "skill_retrieve",
      arguments: {
        skill: { id: environment.skill.skill.id },
        version: { selector: "current" },
        caller: TEST_CALLER,
      },
    });
    environment.storage.failReads = false;
    const error = parseToolError(result);
    expect(error.error).toMatchObject({
      code: "R2_READ_FAILED",
      retryable: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("fixture R2 read failure");
    expect(serialized).not.toContain(environment.skill.markdown);
  });

  it("returns a typed size error when oversized content is forced inline", async () => {
    const result = await service.client.callTool({
      name: "skill_asset_retrieve",
      arguments: {
        skill: { id: environment.skill.skill.id },
        version: { selector: "current" },
        path: "assets/large.bin",
        responseMode: "inline",
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(result).error).toMatchObject({
      code: "ASSET_TOO_LARGE",
      retryable: false,
    });
  });

  it("binds opaque cursors to tool filters and rejects tampering", async () => {
    const first = parseStructured<ContextNotesListOutput>(
      await service.client.callTool({
        name: "context_notes_list",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          state: "active",
          limit: 1,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(first.nextCursor).toEqual(expect.any(String));
    const mismatch = await service.client.callTool({
      name: "context_notes_list",
      arguments: {
        skill: { id: environment.skill.skill.id },
        context: { id: environment.skill.context.context.id },
        state: "all",
        limit: 1,
        cursor: first.nextCursor,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(mismatch).error.code).toBe("CURSOR_FILTER_MISMATCH");
    const cursor = first.nextCursor ?? "";
    const tampered = `${cursor.slice(0, -1)}${cursor.endsWith("a") ? "b" : "a"}`;
    const invalid = await service.client.callTool({
      name: "context_notes_list",
      arguments: {
        skill: { id: environment.skill.skill.id },
        context: { id: environment.skill.context.context.id },
        state: "active",
        limit: 1,
        cursor: tampered,
        caller: TEST_CALLER,
      },
    });
    expect(parseToolError(invalid).error.code).toBe("CURSOR_INVALID");
  });

  it("binds oversized asset downloads to the credential that requested them", async () => {
    const asset = parseStructured<SkillAssetRetrieveOutput>(
      await service.client.callTool({
        name: "skill_asset_retrieve",
        arguments: {
          skill: { id: environment.skill.skill.id },
          version: { selector: "current" },
          path: "assets/large.bin",
          responseMode: "download",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(asset.delivery).toBe("authenticated_download");
    if (asset.delivery !== "authenticated_download") {
      throw new Error("Expected a download grant");
    }
    const denied = await environment.app.fetch(
      new Request(asset.url, {
        headers: {
          authorization: `Bearer ${environment.outsiderServiceToken}`,
        },
      }),
    );
    expect(denied.status).toBe(401);
    expect(await denied.text()).not.toContain(asset.url.split("/").at(-1));

    const permitted = await environment.app.fetch(
      new Request(asset.url, {
        headers: { authorization: `Bearer ${environment.serviceToken}` },
      }),
    );
    expect(permitted.status).toBe(200);
    expect(new Uint8Array(await permitted.arrayBuffer())).toEqual(
      environment.skill.largeAsset,
    );
  });
});

describe("MCP audit fail-closed behavior", () => {
  it("withholds multi-workspace discovery when the atomic audit batch fails", async () => {
    const membershipId = `membership:audit-failure-${crypto.randomUUID()}`;
    await environment.services.database.pool.query(
      `INSERT INTO workspace_memberships
         (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'viewer')`,
      [membershipId, environment.outsider.workspaceId, environment.owner.userId],
    );
    try {
      const auditFailureApp = createMcpApp({
        getServices: async () => environment.services,
        createAuditWriter: () => ({
          record: () => Promise.resolve(),
          recordBatch: () =>
            Promise.reject(
              new Error("postgres://internal-user:internal-password@database"),
            ),
        }),
      });
      const response = await auditFailureApp.fetch(
        new Request(TEST_MCP_RESOURCE, {
          method: "POST",
          headers: {
            authorization: `Bearer ${oauthToken}`,
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            "mcp-protocol-version": "2025-11-25",
          },
          body: JSON.stringify(
            toolCall("workspaces_list", {
              limit: 20,
              caller: TEST_CALLER,
            }),
          ),
        }),
      );
      expect(response.status).toBe(200);
      const result = await rawToolResult(response);
      expect(parseToolError(result).error).toMatchObject({
        code: "AUDIT_WRITE_FAILED",
        retryable: true,
      });
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain(environment.outsider.workspaceId);
      expect(serialized).not.toContain("internal-password");
    } finally {
      await environment.services.database.pool.query(
        "DELETE FROM workspace_memberships WHERE id = $1",
        [membershipId],
      );
    }
  });

  it("withholds private content when the durable audit write fails", async () => {
    const auditFailureApp = createMcpApp({
      getServices: async () => environment.services,
      createAuditWriter: () => ({
        record: () =>
          Promise.reject(
            new Error("postgres://internal-user:internal-password@database"),
          ),
        recordBatch: () =>
          Promise.reject(
            new Error("postgres://internal-user:internal-password@database"),
          ),
      }),
    });
    const response = await auditFailureApp.fetch(
      new Request(TEST_MCP_RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${environment.serviceToken}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify(
          toolCall("skill_retrieve", {
            skill: { id: environment.privateSkill.skill.id },
            version: { selector: "current" },
            caller: TEST_CALLER,
          }),
        ),
      }),
    );
    expect(response.status).toBe(200);
    const result = await rawToolResult(response);
    expect(parseToolError(result).error).toMatchObject({
      code: "AUDIT_WRITE_FAILED",
      retryable: true,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("Never disclose this fixture");
    expect(serialized).not.toContain("internal-password");
    expect(serialized).not.toContain(environment.serviceToken);
  });
});
