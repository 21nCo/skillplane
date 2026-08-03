import type {
  ContextGetOutput,
  ContextNotesListOutput,
  SkillAssetRetrieveOutput,
  SkillRetrieveOutput,
  SkillsSearchOutput,
  SkillVersionsListOutput,
} from "@skillplane/mcp-schema";
import { readAnalytics, rollupUtcDay } from "@skillplane/observability";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseStructured,
  startMcpTestEnvironment,
  TEST_CALLER,
  type ConnectedMcpClient,
  type McpTestEnvironment,
} from "../support/mcp-test-environment.js";

let environment: McpTestEnvironment;
let oauth: ConnectedMcpClient;
let service: ConnectedMcpClient;

beforeAll(async () => {
  environment = await startMcpTestEnvironment("integration");
  const oauthToken = await environment.issueOAuthToken();
  oauth = await environment.connect(oauthToken);
  service = await environment.connect(environment.serviceToken);
}, 60_000);

afterAll(async () => {
  await environment.close();
}, 30_000);

describe("MCP read surface", () => {
  it("publishes protected-resource metadata and initializes through interactive OAuth", async () => {
    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const response = await environment.app.request(path);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({
        resource: "https://mcp.skillplane.dev/mcp",
        authorization_servers: ["https://app.skillplane.dev"],
        bearer_methods_supported: ["header"],
      });
    }

    expect(oauth.transport.protocolVersion).toMatch(/^2025-/);
    expect(oauth.client.getServerVersion()).toMatchObject({
      name: "skillplane",
      version: "1.0.0",
    });
    const listed = await oauth.client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "context_get",
      "context_knowledge_update",
      "context_note_upsert",
      "context_notes_list",
      "skill_amend",
      "skill_asset_retrieve",
      "skill_retrieve",
      "skill_versions_list",
      "skills_search",
    ]);
    for (const tool of listed.tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: ![
          "context_knowledge_update",
          "context_note_upsert",
          "skill_amend",
        ].includes(tool.name),
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.inputSchema).toMatchObject({
        type: "object",
        additionalProperties: false,
      });
      expect(tool.outputSchema).toBeDefined();
    }
  });

  it("searches only authorized workspace content with stable current version identity", async () => {
    const publicSearch = parseStructured<SkillsSearchOutput>(
      await oauth.client.callTool({
        name: "skills_search",
        arguments: {
          query: "authorization",
          workspaceId: environment.owner.workspaceId,
          visibility: ["public"],
          tags: ["review"],
          limit: 20,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(publicSearch.skills).toEqual([
      expect.objectContaining({
        id: environment.skill.skill.id,
        slug: environment.skill.skill.slug,
        visibility: "public",
        currentVersion: {
          id: environment.skill.version.id,
          semanticVersion: "1.0.0",
          digest: environment.skill.version.digest,
        },
      }),
    ]);

    const privateSearch = parseStructured<SkillsSearchOutput>(
      await oauth.client.callTool({
        name: "skills_search",
        arguments: {
          query: "incident",
          workspaceId: environment.owner.workspaceId,
          visibility: ["private"],
          limit: 20,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(privateSearch.skills.map((skill) => skill.id)).toContain(
      environment.privateSkill.skill.id,
    );
  });

  it("retrieves an exact immutable bundle and composes an authorized context without mutation", async () => {
    const beforeVersion = await environment.services.database.pool.query<{
      current_published_version_id: string;
      current_knowledge_revision_id: string;
    }>(
      `SELECT skill.current_published_version_id,
              context.current_knowledge_revision_id
         FROM skills skill
         JOIN skill_contexts context ON context.skill_id = skill.id
        WHERE skill.id = $1 AND context.id = $2`,
      [environment.skill.skill.id, environment.skill.context.context.id],
    );
    const output = parseStructured<SkillRetrieveOutput>(
      await service.client.callTool({
        name: "skill_retrieve",
        arguments: {
          skill: {
            workspaceSlug: `workspace-mcp-integration-${environment.owner.workspaceId
              .split("-")
              .at(-1)}`,
            skillSlug: environment.skill.skill.slug,
          },
          version: {
            selector: "versionId",
            versionId: environment.skill.version.id,
          },
          context: {
            selector: { id: environment.skill.context.context.id },
            knowledge: {
              selector: "revisionId",
              revisionId: environment.skill.context.knowledge.id,
            },
            includeNotes: true,
          },
          caller: TEST_CALLER,
        },
      }),
    );
    expect(output.version).toMatchObject({
      id: environment.skill.version.id,
      revision: 1,
      semanticVersion: "1.0.0",
      state: "published",
      digest: environment.skill.version.digest,
    });
    expect(output.version.manifest.digest).toBe(environment.skill.version.digest);
    expect(output.instructions).toBe(environment.skill.markdown);
    expect(output.files).toEqual(output.version.manifest.files);
    expect(output.context).toMatchObject({
      id: environment.skill.context.context.id,
      knowledge: {
        id: environment.skill.context.knowledge.id,
        digest: environment.skill.context.knowledge.bodyDigest,
        markdown: environment.skill.context.knowledge.body,
      },
    });
    expect(output.context?.notes.map((note) => note.id).sort()).toEqual(
      environment.skill.notes.map((note) => note.id).sort(),
    );

    const afterVersion = await environment.services.database.pool.query(
      `SELECT skill.current_published_version_id,
              context.current_knowledge_revision_id
         FROM skills skill
         JOIN skill_contexts context ON context.skill_id = skill.id
        WHERE skill.id = $1 AND context.id = $2`,
      [environment.skill.skill.id, environment.skill.context.context.id],
    );
    expect(afterVersion.rows).toEqual(beforeVersion.rows);
  });

  it("returns safe inline assets and credential-bound downloads with exact bytes", async () => {
    const text = parseStructured<SkillAssetRetrieveOutput>(
      await service.client.callTool({
        name: "skill_asset_retrieve",
        arguments: {
          skill: { id: environment.skill.skill.id },
          version: { selector: "current" },
          path: "references/checklist.md",
          responseMode: "auto",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(text).toMatchObject({
      delivery: "text",
      text: environment.skill.checklist,
      versionId: environment.skill.version.id,
      bundleDigest: environment.skill.version.digest,
    });

    const binary = parseStructured<SkillAssetRetrieveOutput>(
      await service.client.callTool({
        name: "skill_asset_retrieve",
        arguments: {
          skill: { id: environment.skill.skill.id },
          version: { selector: "current" },
          path: "assets/icon.bin",
          responseMode: "auto",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(binary).toMatchObject({
      delivery: "base64",
      base64: Buffer.from([0, 1, 2, 3, 254, 255]).toString("base64"),
      bundleDigest: environment.skill.version.digest,
    });

    const large = parseStructured<SkillAssetRetrieveOutput>(
      await service.client.callTool({
        name: "skill_asset_retrieve",
        arguments: {
          skill: { id: environment.skill.skill.id },
          version: { selector: "current" },
          path: "assets/large.bin",
          responseMode: "auto",
          caller: TEST_CALLER,
        },
      }),
    );
    expect(large.delivery).toBe("authenticated_download");
    if (large.delivery !== "authenticated_download") {
      throw new Error("Expected authenticated download delivery");
    }
    expect(Date.parse(large.expiresAt) - Date.now()).toBeLessThanOrEqual(
      5 * 60 * 1_000,
    );
    const download = await environment.app.fetch(
      new Request(large.url, {
        headers: { authorization: `Bearer ${environment.serviceToken}` },
      }),
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("cache-control")).toContain("no-store");
    expect(download.headers.get("content-security-policy")).toContain("sandbox");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(
      environment.skill.largeAsset,
    );
  });

  it("paginates authorized published and candidate version history deterministically", async () => {
    const first = parseStructured<SkillVersionsListOutput>(
      await service.client.callTool({
        name: "skill_versions_list",
        arguments: {
          skill: { id: environment.skill.skill.id },
          states: ["published", "pending_review"],
          limit: 1,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(first.versions).toEqual([
      expect.objectContaining({
        id: environment.skill.candidate.id,
        revision: 2,
        state: "pending_review",
        changeSummary: "Add explicit scope validation guidance",
      }),
    ]);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = parseStructured<SkillVersionsListOutput>(
      await service.client.callTool({
        name: "skill_versions_list",
        arguments: {
          skill: { id: environment.skill.skill.id },
          states: ["published", "pending_review"],
          limit: 1,
          cursor: first.nextCursor,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(second.versions).toEqual([
      expect.objectContaining({
        id: environment.skill.version.id,
        revision: 1,
        state: "published",
        digest: environment.skill.version.digest,
      }),
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("reads exact context knowledge and paginates shared notes", async () => {
    const context = parseStructured<ContextGetOutput>(
      await oauth.client.callTool({
        name: "context_get",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { slug: environment.skill.context.context.slug },
          knowledge: {
            selector: "revision",
            revision: environment.skill.context.knowledge.revision,
          },
          includeNotes: false,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(context.context).toMatchObject({
      id: environment.skill.context.context.id,
      metadata: { branch: "main", language: "TypeScript" },
      knowledge: {
        id: environment.skill.context.knowledge.id,
        digest: environment.skill.context.knowledge.bodyDigest,
      },
      notes: [],
    });

    const first = parseStructured<ContextNotesListOutput>(
      await oauth.client.callTool({
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
    expect(first.notes).toHaveLength(1);
    expect(first.notes[0]?.id).toBe(environment.skill.notes[1].id);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = parseStructured<ContextNotesListOutput>(
      await oauth.client.callTool({
        name: "context_notes_list",
        arguments: {
          skill: { id: environment.skill.skill.id },
          context: { id: environment.skill.context.context.id },
          state: "active",
          limit: 1,
          cursor: first.nextCursor,
          caller: TEST_CALLER,
        },
      }),
    );
    expect(second.notes[0]?.id).toBe(environment.skill.notes[0].id);
    expect(second.nextCursor).toBeNull();
  });

  it("persists server-derived principal and credential separately from complete caller metadata", async () => {
    const events = await environment.services.database.pool.query<{
      actor_type: string;
      actor_id: string;
      user_id: string | null;
      agent: string;
      model: string;
      metadata: {
        readonly channel: string;
        readonly credential: { readonly id: string; readonly kind: string };
        readonly caller: Record<string, unknown>;
      };
    }>(
      `SELECT actor_type, actor_id, user_id, agent, model, metadata
         FROM audit_events
        WHERE workspace_id = $1 AND event_type LIKE 'mcp.%'
        ORDER BY occurred_at DESC`,
      [environment.owner.workspaceId],
    );
    expect(events.rows.length).toBeGreaterThanOrEqual(10);
    const serviceEvent = events.rows.find(
      (event) => event.actor_type === "service_principal",
    );
    expect(serviceEvent).toMatchObject({
      actor_type: "service_principal",
      user_id: null,
      agent: TEST_CALLER.agentName,
      model: TEST_CALLER.modelName,
      metadata: {
        channel: "mcp",
        caller: { ...TEST_CALLER, trust: "caller-declared" },
      },
    });
    expect(serviceEvent?.actor_id).not.toBe(TEST_CALLER.agentId);
    expect(serviceEvent?.metadata.credential.id).not.toBe(TEST_CALLER.sessionId);
    const serialized = JSON.stringify(events.rows);
    expect(serialized).not.toContain(environment.serviceToken);
    expect(serialized).not.toContain(environment.skill.markdown);

    const day = new Date().toISOString().slice(0, 10);
    await rollupUtcDay(environment.services.database.pool, {
      day,
      workspaceId: environment.owner.workspaceId,
    });
    const analytics = await readAnalytics(environment.services.database.pool, {
      workspaceId: environment.owner.workspaceId,
      from: day,
      to: day,
    });
    expect(analytics.totals.retrievalCount).toBeGreaterThanOrEqual(10);
    const agentMetric = analytics.dimensions.find(
      (dimension) =>
        dimension.type === "agent" && dimension.value === TEST_CALLER.agentName,
    );
    const modelMetric = analytics.dimensions.find(
      (dimension) =>
        dimension.type === "model" && dimension.value === TEST_CALLER.modelName,
    );
    expect(agentMetric).toMatchObject({ trust: "caller-declared" });
    expect(agentMetric?.eventCount).toBeGreaterThanOrEqual(10);
    expect(modelMetric).toMatchObject({ trust: "caller-declared" });
    expect(modelMetric?.eventCount).toBeGreaterThanOrEqual(10);
  });
});
