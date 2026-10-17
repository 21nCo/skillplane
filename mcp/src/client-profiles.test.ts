import {
  buildMcpFnEffectiveCatalog,
  createSchemaCompiler,
  enrichMcpFnClientProfileCall,
  type McpFnClientProfile,
  type McpFnListedTool,
} from "@mcpfn/core";
import {
  McpFnTestClient,
  runMcpFnClientProfileContracts,
  type McpFnClientProfileContractCase,
} from "@mcpfn/testing";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { ApiServices } from "@skillplane/api";
import { callerDeclarationSchema } from "@skillplane/mcp-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import incident from "../tests/fixtures/oauth-list-skills-incident.json" with { type: "json" };
import type { McpAuditRecord, McpAuditWriter } from "./audit.js";
import type { McpIdentity } from "./auth.js";
import {
  CLAUDE_MCP_CLIENT_ID,
  LINEAR_MCP_CLIENT_ID,
  prepareMcpToolCallRequest,
  OAUTH_CLIENT_PROFILES,
  SKILLPLANE_CLIENT_PROFILES,
  verifiedClientIdentity,
} from "./client-profiles.js";
import { createMcpApp } from "./index.js";
import { skillplaneMcpDeclaration } from "./server.js";
import { SKILLPLANE_MCP_TOOL_COUNT } from "./tool-catalog.js";
import type { McpToolRuntime } from "./tools/shared.js";

const RESOURCE = "https://mcp.skillplane.dev/mcp";
const GENERIC_CLIENT_ID = "dcr-client:agent-example";
const WORKSPACE = {
  id: "workspace:one",
  slug: "one",
  name: "One",
  kind: "personal",
  updated_at: new Date("2026-10-01T00:00:00.000Z"),
};
const SKILL = {
  id: "skill:review",
  workspaceId: WORKSPACE.id,
  slug: "review",
  name: "Review",
  description: "Review pull requests.",
  tags: ["review"],
  visibility: "workspace",
  currentPublishedVersionId: "version:review:1",
  currentSemanticVersion: "1.0.0",
  archivedAt: null,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};
const DECLARED_CALLER = {
  agentId: "service-agent",
  agentName: "Service agent",
  modelProvider: "Example",
  modelName: "Example model",
  modelVersion: "1",
  clientName: "Example client",
  clientVersion: "1",
  runId: "run:declared",
  sessionId: "session:declared",
  conversationId: "conversation:declared",
};
const SECRET_VALUE = "argument-value-must-not-leak";

type Principal =
  { readonly kind: "oauth"; readonly clientId: string } | { readonly kind: "service" };

interface Harness {
  readonly app: ReturnType<typeof createMcpApp>;
  readonly token: string;
  readonly audit: McpAuditRecord[];
}

function harness(principal: Principal): Harness {
  const audit: McpAuditRecord[] = [];
  const writer: McpAuditWriter = {
    record: async (event) => {
      audit.push(event);
    },
    recordBatch: async (events) => {
      audit.push(...events);
    },
  };
  const controlQuery = async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM service_principals")) {
      return {
        rows: [
          {
            id: "service:test",
            workspace_id: WORKSPACE.id,
            name: "Test service",
            role: "viewer",
            scopes: ["skills:read"],
            delegated_user_id: null,
            expires_at: null,
            revoked_at: null,
            credential_version: 1,
            authfn_api_key_id: "api-key:test",
          },
        ],
      };
    }
    if (sql.includes("FROM workspace_memberships membership")) {
      return { rows: [{ ...WORKSPACE, role: "owner" }] };
    }
    if (sql.includes("FROM workspace_memberships"))
      return { rows: [{ role: "owner" }] };
    if (sql.includes("FROM workspaces workspace")) {
      return { rows: [{ ...WORKSPACE, role: params[1] }] };
    }
    if (sql.includes("FROM workspaces")) {
      const value = params[0];
      return {
        rows:
          value === WORKSPACE.id || value === WORKSPACE.slug
            ? [{ ...WORKSPACE, role: "viewer" }]
            : [],
      };
    }
    return { rows: [] };
  };
  const services = {
    auth: {
      oauth: {
        resource: RESOURCE,
        tokenPepper: "client-profile-test-pepper-at-least-32-characters",
        now: () => new Date(),
        pool: {
          query: async () => ({
            rows:
              principal.kind === "oauth"
                ? [
                    {
                      id: "oauth-token:test",
                      user_id: "user:test",
                      client_id: principal.clientId,
                      resource: RESOURCE,
                      scopes: ["skills:read", "contexts:read"],
                      expires_at: new Date("2099-01-01T00:00:00.000Z"),
                      revoked_at: null,
                    },
                  ]
                : [],
          }),
        },
      },
      apiKeys: {
        authenticate: async () => ({
          type: "api-key",
          actorType: "api-key",
          actorId: "api-key:test",
          metadata: {
            kind: "skillplane_service_principal",
            servicePrincipalId: "service:test",
            workspaceId: WORKSPACE.id,
            credentialVersion: 1,
          },
        }),
      },
    },
    tenancySecret: "client-profile-test-tenancy-secret-at-least-32-characters",
    database: { role: "combined", pool: {} },
    controlDatabase: { pool: { query: controlQuery } },
    skillService: {
      listPage: async () => ({ skills: [SKILL], nextCursor: null }),
    },
    skillSearchService: {
      search: async () => ({
        skills: [
          {
            ...SKILL,
            workspaceSlug: WORKSPACE.slug,
            currentVersionId: SKILL.currentPublishedVersionId,
            semanticVersion: SKILL.currentSemanticVersion,
            digest: `sha256:${"a".repeat(64)}`,
          },
        ],
        nextCursor: null,
      }),
    },
  } as unknown as ApiServices;
  return {
    app: createMcpApp({
      getServices: async () => services,
      createAuditWriter: () => writer,
    }),
    token:
      principal.kind === "oauth"
        ? "spo_client_profile_test"
        : "spk_client_profile_test",
    audit,
  };
}

function rawCall({ app, token }: Harness, body: unknown): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request(RESOURCE, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

type McpFnTarget = McpFnClientProfileContractCase["target"];
type McpFnTransport = Awaited<ReturnType<McpFnTarget["open"]>>["transport"];

/** Drives the production Hono app, including McpFn auth, in process. */
function appTarget({ app, token }: Harness): McpFnTarget {
  return {
    kind: "skillplane-app",
    describe: () => ({ kind: "skillplane-app" }),
    open: async () => ({
      // The SDK declares sessionId as optional while McpFn's handle type uses
      // exact optional properties; the runtime object is the same transport.
      transport: new StreamableHTTPClientTransport(new URL(RESOURCE), {
        requestInit: { headers: { authorization: `Bearer ${token}` } },
        fetch: async (input, init) => app.fetch(new Request(input, init)),
      }) as unknown as McpFnTransport,
    }),
  };
}

async function connect(target: Harness, clientInfo = { name: "test", version: "1" }) {
  return McpFnTestClient.connectTarget(appTarget(target), clientInfo);
}

function toolError(result: CallToolResult) {
  const text = result.content.find((item) => item.type === "text");
  if (!result.isError || text?.type !== "text")
    throw new Error("Expected a tool error");
  return JSON.parse(text.text) as {
    readonly error: {
      readonly code: string;
      readonly details: {
        readonly lifecycleStage: string;
        readonly issues: readonly Record<string, string>[];
      };
    };
  };
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
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
  };
}

const SERVICE_IDENTITY: McpIdentity = {
  kind: "service",
  actorType: "service_principal",
  actorId: "service:test",
  servicePrincipalId: "service:test",
  userId: null,
  credentialId: "api-key:test",
  credentialKind: "service_principal",
  workspaceId: WORKSPACE.id,
  displayName: "Test service",
  role: "viewer",
  scopes: ["skills:read"],
};

function runtimeFor(identity: McpIdentity): McpToolRuntime {
  return { identity } as McpToolRuntime;
}

function profileById(id: string): McpFnClientProfile<McpToolRuntime> {
  const profile = SKILLPLANE_CLIENT_PROFILES.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Unknown profile ${id}`);
  return profile;
}

function canonicalTools(): McpFnListedTool[] {
  return skillplaneMcpDeclaration.registry.listTools();
}

/** A profile is symmetric when every field it hides is exactly what it enriches. */
async function assertProfileSymmetry(
  profile: McpFnClientProfile<McpToolRuntime>,
  identity: McpIdentity,
): Promise<void> {
  const resolved = {
    context: runtimeFor(identity),
    extra: {} as never,
    verifiedIdentity: await verifiedClientIdentity(identity),
    reportedClient: {},
    profile,
  };
  const canonical = canonicalTools();
  const effective = await buildMcpFnEffectiveCatalog({
    canonicalTools: canonical,
    resolved,
  });
  for (const tool of effective.tools) {
    const source = canonical.find((candidate) => candidate.name === tool.name);
    const hidden = Object.keys(source?.inputSchema.properties ?? {}).filter(
      (name) => !Object.hasOwn(tool.inputSchema.properties ?? {}, name),
    );
    const enriched = (await enrichMcpFnClientProfileCall({
      resolved,
      tool,
      arguments: {},
    })) as Record<string, unknown>;
    expect(Object.keys(enriched).toSorted()).toEqual(hidden.toSorted());
    if (hidden.includes("caller")) {
      expect(callerDeclarationSchema.safeParse(enriched.caller).success).toBe(true);
    }
  }
}

/** Property names and required sets at every nesting level of a schema. */
function schemaShape(schema: unknown, path = "#"): string[] {
  if (Array.isArray(schema)) {
    return schema.flatMap((item, index) =>
      schemaShape(item, `${path}/${String(index)}`),
    );
  }
  if (typeof schema !== "object" || schema === null) return [];
  const shape: string[] = [];
  for (const [key, value] of Object.entries(schema)) {
    if (key === "required" && Array.isArray(value)) {
      shape.push(`${path}/required=${value.join(",")}`);
    } else if (key === "properties" && typeof value === "object" && value !== null) {
      for (const [name, child] of Object.entries(value)) {
        shape.push(`${path}/properties/${name}`);
        shape.push(...schemaShape(child, `${path}/properties/${name}`));
      }
    } else {
      shape.push(...schemaShape(value, `${path}/${key}`));
    }
  }
  return shape;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authenticated client profiles", () => {
  it("serves each verified identity its documented effective catalog", async () => {
    const claude = harness({ kind: "oauth", clientId: CLAUDE_MCP_CLIENT_ID });
    const linear = harness({ kind: "oauth", clientId: LINEAR_MCP_CLIENT_ID });
    const generic = harness({ kind: "oauth", clientId: GENERIC_CLIENT_ID });
    const service = harness({ kind: "service" });
    // Reported client metadata is deliberately misleading: only verified
    // identity may select a profile.
    const cases: McpFnClientProfileContractCase[] = [
      {
        id: OAUTH_CLIENT_PROFILES.claude.id,
        version: "1",
        target: appTarget(claude),
        clientInfo: { name: "linear", version: "1" },
      },
      {
        id: OAUTH_CLIENT_PROFILES.linear.id,
        version: "1",
        target: appTarget(linear),
        clientInfo: { name: "claude-ai", version: "1" },
      },
      {
        id: OAUTH_CLIENT_PROFILES.generic.id,
        version: "1",
        target: appTarget(generic),
        clientInfo: { name: "claude-ai", version: "1" },
      },
      {
        id: "skillplane/service-principal",
        version: "1",
        target: appTarget(service),
        clientInfo: { name: "claude-ai", version: "1" },
      },
    ];
    const report = await runMcpFnClientProfileContracts({ profiles: cases });
    expect(report.ok, JSON.stringify(report)).toBe(true);

    const listed = new Map<string, Tool[]>();
    for (const [name, target] of Object.entries({ claude, linear, generic, service })) {
      const client = await connect(target, { name: "claude-ai", version: "1" });
      listed.set(name, await client.listTools());
      await client.close();
    }
    for (const [name, id] of [
      ["claude", OAUTH_CLIENT_PROFILES.claude.id],
      ["linear", OAUTH_CLIENT_PROFILES.linear.id],
      ["generic", OAUTH_CLIENT_PROFILES.generic.id],
      ["service", "skillplane/service-principal"],
    ] as const) {
      const result = report.profiles.find((entry) => entry.profile.id === id);
      const tools = listed.get(name) ?? [];
      // Reviewed per-profile effective catalog: McpFn hashes plus the input
      // contract each model actually sees.
      const snapshot = {
        ...result?.snapshot,
        catalogBytes: Buffer.byteLength(JSON.stringify({ tools })),
        tools: result?.snapshot?.tools.map((entry) => {
          const tool = tools.find((candidate) => candidate.name === entry.name);
          return {
            ...entry,
            inputProperties: Object.keys(tool?.inputSchema.properties ?? {}),
            required: tool?.inputSchema.required ?? [],
            outputSchema: tool?.outputSchema !== undefined,
          };
        }),
      };
      await expect(`${JSON.stringify(snapshot, null, 2)}\n`).toMatchFileSnapshot(
        `../tests/conformance/__snapshots__/client-profiles/${id.replace("/", "__")}.json`,
      );
    }
    for (const name of ["claude", "linear", "generic"]) {
      const tools = listed.get(name) ?? [];
      expect(tools).toHaveLength(SKILLPLANE_MCP_TOOL_COUNT);
      for (const tool of tools) {
        expect(tool.inputSchema).not.toHaveProperty("properties.caller");
        expect(tool.inputSchema.required ?? []).not.toContain("caller");
        expect(tool.inputSchema).not.toHaveProperty("required", []);
      }
    }
    for (const name of ["claude", "generic"]) {
      for (const tool of listed.get(name) ?? []) {
        expect(tool).toHaveProperty("outputSchema");
        expect(tool).toHaveProperty("annotations");
        expect(tool.inputSchema).toHaveProperty("additionalProperties", false);
      }
    }
    expect(listed.get("claude")).toEqual(listed.get("generic"));
    const linearTools = listed.get("linear") ?? [];
    const linearWire = await rawCall(linear, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/list",
    });
    expect(Buffer.byteLength(await linearWire.text())).toBeLessThan(32 * 1_024);
    for (const tool of linearTools) {
      expect(tool).not.toHaveProperty("outputSchema");
      expect(tool).not.toHaveProperty("annotations");
      expect(tool).not.toHaveProperty("title");
      expect(tool.inputSchema).not.toHaveProperty("$schema");
      // Compaction is presentation only: names and required sets match the
      // McpFn effective catalog every other OAuth client receives.
      const projected = listed.get("claude")?.find((entry) => entry.name === tool.name);
      expect(schemaShape(tool.inputSchema)).toEqual(
        schemaShape(projected?.inputSchema),
      );
    }
    expect(listed.get("service")).toEqual(canonicalTools());
    for (const tool of listed.get("service") ?? []) {
      expect(tool.inputSchema.required).toContain("caller");
    }
  });

  it("keeps projection and enrichment symmetric for every production profile", async () => {
    await assertProfileSymmetry(
      profileById(OAUTH_CLIENT_PROFILES.claude.id),
      oauthIdentity(CLAUDE_MCP_CLIENT_ID),
    );
    await assertProfileSymmetry(
      profileById(OAUTH_CLIENT_PROFILES.linear.id),
      oauthIdentity(LINEAR_MCP_CLIENT_ID),
    );
    await assertProfileSymmetry(
      profileById(OAUTH_CLIENT_PROFILES.generic.id),
      oauthIdentity(GENERIC_CLIENT_ID),
    );
    await assertProfileSymmetry(
      profileById("skillplane/service-principal"),
      SERVICE_IDENTITY,
    );
  });

  it("fails the symmetry check when projection and enrichment diverge", async () => {
    const generic = profileById(OAUTH_CLIENT_PROFILES.generic.id);
    const identity = oauthIdentity(GENERIC_CLIENT_ID);
    const withoutProjection = { ...generic };
    delete withoutProjection.projectCatalog;
    const withoutOwnership = { ...generic };
    delete withoutOwnership.serverOwnedArguments;
    await expect(
      assertProfileSymmetry(
        { ...generic, enrichArguments: ({ arguments: args }) => args },
        identity,
      ),
    ).rejects.toMatchObject({ code: "MCPFN_MISSING_TRUSTED_CONTEXT" });
    await expect(
      assertProfileSymmetry(withoutProjection, identity),
    ).rejects.toMatchObject({
      code: "MCPFN_PROFILE_ASYMMETRIC",
    });
    await expect(
      assertProfileSymmetry(withoutOwnership, identity),
    ).rejects.toMatchObject({
      code: "MCPFN_PROFILE_ASYMMETRIC",
    });
    await expect(
      assertProfileSymmetry(
        {
          ...generic,
          enrichArguments: ({ arguments: args }) => ({
            ...args,
            caller: DECLARED_CALLER,
            limit: 1,
          }),
        },
        identity,
      ),
    ).rejects.toMatchObject({ code: "MCPFN_PROFILE_ARGUMENT_MUTATION" });
  });

  it("fails closed when trusted OAuth context is missing", async () => {
    const claude = profileById(OAUTH_CLIENT_PROFILES.claude.id);
    const tool = canonicalTools().find((candidate) => candidate.name === "skills_list");
    if (!tool) throw new Error("skills_list is not registered");
    for (const identity of [SERVICE_IDENTITY, oauthIdentity(GENERIC_CLIENT_ID)]) {
      await expect(
        enrichMcpFnClientProfileCall({
          resolved: {
            context: runtimeFor(identity),
            extra: {} as never,
            verifiedIdentity: {
              subject: CLAUDE_MCP_CLIENT_ID,
              attributes: { principal: "oauth" },
            },
            reportedClient: {},
            profile: claude,
          },
          tool,
          arguments: { workspace: { id: WORKSPACE.id } },
        }),
      ).rejects.toMatchObject({ code: "MCPFN_MISSING_TRUSTED_CONTEXT" });
    }
  });

  it("bounds oversized client identifiers to the generic profile", async () => {
    const verified = await verifiedClientIdentity(
      oauthIdentity(`https://agent.example.test/${"a".repeat(2_000)}`),
    );
    expect(verified.subject).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const matched = [];
    for (const profile of SKILLPLANE_CLIENT_PROFILES) {
      if (await profile.matches(verified)) matched.push(profile.id);
    }
    expect(matched).toEqual([OAUTH_CLIENT_PROFILES.generic.id]);
  });
});

describe("authenticated tool calls", () => {
  it("overwrites forged OAuth caller attribution with the verified profile", async () => {
    for (const [clientId, definition] of [
      [CLAUDE_MCP_CLIENT_ID, OAUTH_CLIENT_PROFILES.claude],
      [LINEAR_MCP_CLIENT_ID, OAUTH_CLIENT_PROFILES.linear],
      [GENERIC_CLIENT_ID, OAUTH_CLIENT_PROFILES.generic],
    ] as const) {
      const target = harness({ kind: "oauth", clientId });
      const client = await connect(target, { name: "claude-ai", version: "1" });
      for (const args of [{}, { caller: { ...DECLARED_CALLER, agentId: "forged" } }]) {
        const result = await client.callTool("workspaces_list", args);
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
      }
      await client.close();
      expect(target.audit).toHaveLength(2);
      for (const event of target.audit) {
        expect(event.caller).toMatchObject(definition.caller);
        expect(event.caller.runId).toMatch(
          new RegExp(`^${definition.invocationPrefix}-run:[0-9a-f-]{36}$`, "u"),
        );
      }
      expect(target.audit[0]?.caller.runId).not.toBe(target.audit[1]?.caller.runId);
    }
  });

  it("keeps the canonical caller-declared contract for service principals", async () => {
    const target = harness({ kind: "service" });
    const client = await connect(target);
    const declared = await client.callTool("workspaces_list", {
      caller: DECLARED_CALLER,
    });
    expect(declared.isError, JSON.stringify(declared)).not.toBe(true);
    expect(target.audit[0]?.caller).toEqual(DECLARED_CALLER);

    const missing = toolError(await client.callTool("workspaces_list", {}));
    expect(missing.error.code).toBe("MCPFN_INVALID_ARGUMENTS");
    expect(missing.error.details.issues).toContainEqual(
      expect.objectContaining({ keyword: "required", missingProperty: "caller" }),
    );
    await client.close();
  });

  it("accepts both nested selectors and the flat alias on discovery tools for every identity", async () => {
    for (const principal of [
      { kind: "oauth", clientId: GENERIC_CLIENT_ID },
      { kind: "service" },
    ] as const) {
      const target = harness(principal);
      const client = await connect(target);
      const caller = principal.kind === "service" ? { caller: DECLARED_CALLER } : {};
      for (const selector of [
        { workspace: { id: WORKSPACE.id } },
        { workspace: { slug: WORKSPACE.slug } },
        { workspaceId: WORKSPACE.id },
      ]) {
        const listed = await client.callTool("skills_list", { ...selector, ...caller });
        expect(listed.isError, JSON.stringify(listed)).not.toBe(true);
        expect(listed.structuredContent).toMatchObject({
          workspace: { id: WORKSPACE.id },
          skills: [{ id: SKILL.id }],
        });
        const searched = await client.callTool("skills_search", {
          query: "review",
          ...selector,
          ...caller,
        });
        expect(searched.isError, JSON.stringify(searched)).not.toBe(true);
        expect(searched.structuredContent).toMatchObject({
          skills: [{ id: SKILL.id }],
        });
      }
      for (const [selector, rejectedProperty] of [
        [{ workspace: { id: WORKSPACE.id }, workspaceId: WORKSPACE.id }, "workspaceId"],
        [{ workspace_id: WORKSPACE.id }, "workspace_id"],
      ] as const) {
        for (const [tool, extra] of [
          ["skills_list", {}],
          ["skills_search", { query: "review" }],
        ] as const) {
          const rejected = toolError(
            await client.callTool(tool, { ...selector, ...extra, ...caller }),
          );
          expect(rejected.error.code).toBe("MCPFN_INVALID_ARGUMENTS");
          expect(rejected.error.details.issues).toContainEqual(
            expect.objectContaining({
              keyword: "additionalProperties",
              instancePath: "/",
              rejectedProperty,
            }),
          );
        }
      }
      await client.close();
    }
  });

  it("emits one redacted, correlated diagnostic for a pre-handler rejection", async () => {
    const target = harness({ kind: "oauth", clientId: CLAUDE_MCP_CLIENT_ID });
    const logs: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const response = await rawCall(target, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "skills_list",
        arguments: { workspace_id: SECRET_VALUE, caller: { agentId: SECRET_VALUE } },
      },
    });
    const requestId = response.headers.get("x-skillplane-request-id");
    const body = await response.text();
    const result = (JSON.parse(body) as { readonly result: CallToolResult }).result;
    const error = toolError(result);
    expect(error.error).toMatchObject({
      code: "MCPFN_INVALID_ARGUMENTS",
      details: {
        lifecycleStage: "input-validation",
        profile: { id: OAUTH_CLIENT_PROFILES.claude.id, version: "1" },
      },
    });
    expect(error.error.details.issues).toContainEqual({
      path: "/",
      instancePath: "/",
      schemaPath: "#/additionalProperties",
      keyword: "additionalProperties",
      message: expect.any(String),
      rejectedProperty: "workspace_id",
    });
    expect(error.error.details.issues).toContainEqual(
      expect.objectContaining({ keyword: "required", missingProperty: "workspace" }),
    );
    expect(body).not.toContain(SECRET_VALUE);

    const diagnostics = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((entry) => entry.event === "mcp.tool.rejected_before_handler");
    expect(requestId).toMatch(/^mcp-request:[0-9a-f-]{36}$/u);
    expect(diagnostics).toEqual([
      {
        component: "mcp",
        event: "mcp.tool.rejected_before_handler",
        requestId,
        tool: "skills_list",
        profileId: `${OAUTH_CLIENT_PROFILES.claude.id}@1`,
        stage: "input-validation",
        code: "MCPFN_INVALID_ARGUMENTS",
        actorType: "user",
        actorId: "user:test",
        issues: expect.arrayContaining([
          {
            keyword: "additionalProperties",
            instancePath: "/",
            schemaPath: "#/additionalProperties",
            rejectedProperty: "workspace_id",
          },
        ]),
      },
    ]);
    expect(logs.join("\n")).not.toContain(SECRET_VALUE);
    expect(logs.join("\n")).not.toContain(target.token);
    expect(target.audit).toEqual([]);
  });

  it("does not emit a diagnostic when the handler runs", async () => {
    const target = harness({ kind: "oauth", clientId: GENERIC_CLIENT_ID });
    const logs: string[] = [];
    vi.spyOn(console, "info").mockImplementation((line: unknown) => {
      logs.push(String(line));
    });
    const response = await rawCall(target, {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "workspaces_list", arguments: {} },
    });
    expect(response.status).toBe(200);
    expect(logs.join("\n")).not.toContain("mcp.tool.rejected_before_handler");
  });
});

describe("OAuth list-skills incident regression", () => {
  function incidentArguments(): Record<string, unknown> {
    return JSON.parse(
      JSON.stringify(incident.rejectedArguments).replaceAll(
        incident.redactedWorkspaceId,
        WORKSPACE.id,
      ),
    ) as Record<string, unknown>;
  }

  it("fails on the pre-fix path that published the canonical schema to OAuth clients", async () => {
    const validate = createSchemaCompiler().compile(incident.effectiveInputSchema);
    expect(validate(incidentArguments())).toBe(false);

    // The pre-fix runtime: the canonical declaration with no client profile
    // and no pre-validation normalization.
    const server = skillplaneMcpDeclaration.createServer({
      context: () => runtimeFor(oauthIdentity(CLAUDE_MCP_CLIENT_ID)),
    });
    const client = await McpFnTestClient.connect(server);
    const listed = await client.listTools();
    expect(listed.find((tool) => tool.name === incident.tool)?.inputSchema).toEqual(
      incident.effectiveInputSchema,
    );
    const rejected = toolError(
      await client.callTool(incident.tool, incidentArguments()),
    );
    expect(rejected.error.code).toBe("MCPFN_INVALID_ARGUMENTS");
    expect(rejected.error.details.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rejectedProperty: "workspaceId" }),
        expect.objectContaining({ missingProperty: "caller" }),
      ]),
    );
    await client.close();
  });

  it("reaches skills_list and returns the seeded skills through the corrected profile", async () => {
    const target = harness({ kind: "oauth", clientId: CLAUDE_MCP_CLIENT_ID });
    const client = await connect(target, { name: "claude-ai", version: "1" });
    const tool = (await client.listTools()).find(
      (entry) => entry.name === incident.tool,
    );
    expect(tool?.inputSchema).not.toHaveProperty("properties.caller");
    const result = await client.callTool(incident.tool, incidentArguments());
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      workspace: { id: WORKSPACE.id },
      skills: [{ id: SKILL.id, name: SKILL.name }],
    });
    expect(target.audit[0]?.caller).toMatchObject(OAUTH_CLIENT_PROFILES.claude.caller);
    await client.close();
  });
});

describe("pre-validation normalization", () => {
  function post(body: unknown): Request {
    return new Request(RESOURCE, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  function call(name: string, args: unknown, id = 1) {
    return {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name, arguments: args },
    };
  }

  it("returns untouched requests when nothing needs normalizing", async () => {
    for (const request of [
      post(call("skills_list", { workspace: { id: WORKSPACE.id } })),
      post(call("skills_list", { workspaceId: 7 })),
      post(call("skill_retrieve", { workspaceId: WORKSPACE.id })),
      post(call("workspaces_list", { caller: DECLARED_CALLER })),
      post({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      new Request(RESOURCE, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    ]) {
      const prepared = await prepareMcpToolCallRequest(request, SERVICE_IDENTITY);
      expect(prepared.request).toBe(request);
    }
  });

  it("normalizes every message in a batch", async () => {
    const prepared = await prepareMcpToolCallRequest(
      post([
        call("skills_list", { workspaceId: WORKSPACE.id, caller: DECLARED_CALLER }, 1),
        call("skills_search", { query: "q", workspaceId: WORKSPACE.id }, 2),
      ]),
      oauthIdentity(GENERIC_CLIENT_ID),
    );
    const batch = (await prepared.request.json()) as {
      readonly params: { readonly arguments: Record<string, unknown> };
    }[];
    expect(batch.map((message) => message.params.arguments)).toEqual([
      { workspace: { id: WORKSPACE.id } },
      { query: "q", workspace: { id: WORKSPACE.id } },
    ]);
    expect(prepared.calledTools).toEqual(new Set(["skills_list", "skills_search"]));
  });

  it("narrows the catalog only for requests made entirely of tool calls", async () => {
    for (const body of [
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      [call("skills_list", {}), { jsonrpc: "2.0", id: 2, method: "tools/list" }],
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: 7 } },
      [],
    ]) {
      const prepared = await prepareMcpToolCallRequest(post(body), SERVICE_IDENTITY);
      expect(prepared.calledTools).toBeNull();
    }
  });
});
