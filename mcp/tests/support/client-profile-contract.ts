import type { SchemaEngine } from "@mcpfn/core";
import { createSchemaCompiler } from "@mcpfn/core";
import { McpFnTestClient, type McpFnClientProfileContractCase } from "@mcpfn/testing";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ApiServices } from "@skillplane/api";
import type { RuntimeBindings } from "@skillplane/config";
import { afterEach, describe, expect, it, vi } from "vitest";
import incident from "../fixtures/oauth-list-skills-incident.json" with { type: "json" };
import type { McpAuditRecord, McpAuditWriter } from "../../src/audit.js";
import type { McpIdentity } from "../../src/auth.js";
import {
  CLAUDE_MCP_CLIENT_ID,
  OAUTH_CLIENT_PROFILES,
} from "../../src/client-profiles.js";
import { createMcpApp } from "../../src/index.js";
import { skillplaneMcpDeclaration } from "../../src/server.js";
import type { McpToolRuntime } from "../../src/tools/shared.js";
import { createRoutedMcpApplication } from "../../src/workspace-routing.js";

/*
 * Shared fixtures for the client-profile contract. The diagnostic suite runs
 * once per McpFn schema engine: Ajv under Node and @cfworker/json-schema, which
 * production Cloudflare Workers select.
 */

export const RESOURCE = "https://mcp.skillplane.dev/mcp";
export const GENERIC_CLIENT_ID = "dcr-client:agent-example";
export const WORKSPACE = {
  id: "workspace:one",
  slug: "one",
  name: "One",
  kind: "personal",
  updated_at: new Date("2026-10-01T00:00:00.000Z"),
};
export const SKILL = {
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
export const DECLARED_CALLER = {
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
export const SECRET_VALUE = "argument-value-must-not-leak";

export type Principal =
  { readonly kind: "oauth"; readonly clientId: string } | { readonly kind: "service" };

export interface Harness {
  readonly app: ReturnType<typeof createMcpApp>;
  readonly services: ApiServices;
  readonly token: string;
  readonly audit: McpAuditRecord[];
  /** Workspace data reads; a gateway must never perform one. */
  readonly workspaceReads: string[];
}

export interface HarnessOptions {
  /** "control" models a gateway or control-plane deployment. */
  readonly databaseRole?: "combined" | "control" | "regional";
}

export function harness(principal: Principal, options: HarnessOptions = {}): Harness {
  const audit: McpAuditRecord[] = [];
  const workspaceReads: string[] = [];
  const writer: McpAuditWriter = {
    record: async (event) => {
      audit.push(event);
    },
    recordBatch: async (events) => {
      audit.push(...events);
    },
  };
  const controlQuery = async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM workspace_placements")) {
      return {
        rows:
          params[0] === WORKSPACE.id
            ? [
                {
                  workspace_id: WORKSPACE.id,
                  region_id: "in-south",
                  epoch: 1,
                  state: "active",
                  updated_at: new Date("2026-10-01T00:00:00.000Z"),
                  cache_expires_at: null,
                  destination_ref: null,
                  moving_to_region_id: null,
                  previous_region_id: null,
                  migration: null,
                },
              ]
            : [],
      };
    }
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
    database: { role: options.databaseRole ?? "combined", pool: {} },
    controlDatabase: { pool: { query: controlQuery } },
    skillService: {
      listPage: async () => {
        workspaceReads.push("skills_list");
        return { skills: [SKILL], nextCursor: null };
      },
    },
    skillSearchService: {
      search: async () => {
        workspaceReads.push("skills_search");
        return {
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
        };
      },
    },
  } as unknown as ApiServices;
  return {
    app: createMcpApp({
      getServices: async () => services,
      createAuditWriter: () => writer,
    }),
    services,
    token:
      principal.kind === "oauth"
        ? "spo_client_profile_test"
        : "spk_client_profile_test",
    audit,
    workspaceReads,
  };
}

export function mcpRequest(token: string | null, body: unknown): Request {
  return new Request(RESOURCE, {
    method: "POST",
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2025-11-25",
    },
    body: JSON.stringify(body),
  });
}

export function rawCall({ app, token }: Harness, body: unknown): Promise<Response> {
  return Promise.resolve(app.fetch(mcpRequest(token, body)));
}

export type McpFnTarget = McpFnClientProfileContractCase["target"];
export type McpFnTransport = Awaited<ReturnType<McpFnTarget["open"]>>["transport"];

/** Drives the production Hono app, including McpFn auth, in process. */
export function appTarget({ app, token }: Harness): McpFnTarget {
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

export async function connect(
  target: Harness,
  clientInfo = { name: "test", version: "1" },
) {
  return McpFnTestClient.connectTarget(appTarget(target), clientInfo);
}

export function toolError(result: CallToolResult) {
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

export function oauthIdentity(clientId: string): McpIdentity {
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

export const SERVICE_IDENTITY: McpIdentity = {
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

export function runtimeFor(identity: McpIdentity): McpToolRuntime {
  return { identity } as McpToolRuntime;
}

const objectStorage = {
  head: async () => null,
  get: async () => null,
  put: async () => null,
  delete: async () => undefined,
  list: async () => ({ objects: [] }),
};

/** A gateway whose only regional cell is served by `cell`. */
export function gatewayBindings(cell: (request: Request) => Promise<Response>) {
  return {
    RUNTIME_ENV: "local",
    SKILLPLANE_ROLE: "gateway",
    SKILLPLANE_TOPOLOGY: JSON.stringify({
      version: 1,
      mode: "single-cell",
      public: {
        appAuthority: "https://app.skillplane.dev",
        mcpResource: RESOURCE,
      },
      controlPlane: {
        regionId: "global",
        databaseBinding: "CONTROL_HYPERDRIVE",
        publicObjectStorageBinding: "PUBLIC_SKILL_BUNDLES",
        issuer: "https://app.skillplane.dev",
        oauthResource: RESOURCE,
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
    PUBLIC_SKILL_BUNDLES: objectStorage,
    WORKSPACE_ROUTING_KEYS: JSON.stringify({
      current: "routing-only-secret-material-32-bytes",
    }),
    CELL_MCP: { fetch: cell },
  } as unknown as RuntimeBindings;
}

function captureInfoLogs(): string[] {
  const logs: string[] = [];
  vi.spyOn(console, "info").mockImplementation((line: unknown) => {
    logs.push(String(line));
  });
  return logs;
}

function diagnosticEvents(logs: readonly string[]): Record<string, unknown>[] {
  return logs
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((entry) => entry.event === "mcp.tool.rejected_before_handler");
}

function toolCall(name: string, args: unknown) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name, arguments: args },
  };
}

async function protocolToolError(response: Response) {
  const body = await response.text();
  const result = (JSON.parse(body) as { readonly result: CallToolResult }).result;
  return { body, error: toolError(result).error };
}

const UNKNOWN_WORKSPACE_ID_ISSUES = [
  {
    path: "/",
    instancePath: "/",
    schemaPath: "#/additionalProperties",
    keyword: "additionalProperties",
    message: 'must not have unknown property "workspace_id"',
    rejectedProperty: "workspace_id",
  },
  {
    path: "/",
    instancePath: "/",
    schemaPath: "#/required",
    keyword: "required",
    message: 'must have required property "workspace"',
    missingProperty: "workspace",
  },
];

const BOUND_VIOLATION = 424_242;

/** Invalid values for declared properties: one bound, one enum member. */
const DECLARED_VALUE_ISSUES = [
  {
    path: "/limit",
    instancePath: "/limit",
    schemaPath: "#/properties/limit/maximum",
    keyword: "maximum",
    message: "must satisfy the maximum constraint at #/properties/limit/maximum",
  },
  {
    path: "/visibility/0",
    instancePath: "/visibility/0",
    schemaPath: "#/properties/visibility/items/enum",
    keyword: "enum",
    message: "must satisfy the enum constraint at #/properties/visibility/items/enum",
  },
];

/** The evidence event carries each client issue without path alias or message. */
function structuralIssues(issues: readonly Record<string, unknown>[]) {
  return issues.map((issue) =>
    Object.fromEntries(
      Object.entries(issue).filter(([key]) => key !== "path" && key !== "message"),
    ),
  );
}

export function describeDiagnosticContract(engine: SchemaEngine): void {
  describe(`pre-handler diagnostics on the ${engine} schema engine`, () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("validates tool input with this engine", () => {
      const registry = skillplaneMcpDeclaration.registry as unknown as {
        readonly schemaCompiler: { readonly engine: SchemaEngine };
      };
      expect(registry.schemaCompiler.engine).toBe(engine);
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
          const listed = await client.callTool("skills_list", {
            ...selector,
            ...caller,
          });
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
          [
            { workspace: { id: WORKSPACE.id }, workspaceId: WORKSPACE.id },
            "workspaceId",
          ],
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

    it("emits one redacted, correlated diagnostic naming the rejected property", async () => {
      const target = harness({ kind: "oauth", clientId: CLAUDE_MCP_CLIENT_ID });
      const logs = captureInfoLogs();
      const response = await rawCall(
        target,
        toolCall("skills_list", {
          workspace_id: SECRET_VALUE,
          caller: { agentId: SECRET_VALUE },
        }),
      );
      const requestId = response.headers.get("x-skillplane-request-id");
      const { body, error } = await protocolToolError(response);
      expect(error).toEqual({
        code: "MCPFN_INVALID_ARGUMENTS",
        message: "Invalid arguments for skills_list",
        details: {
          issues: UNKNOWN_WORKSPACE_ID_ISSUES,
          lifecycleStage: "input-validation",
          profile: { id: OAUTH_CLIENT_PROFILES.claude.id, version: "1" },
        },
      });
      expect(body).not.toContain(SECRET_VALUE);
      expect(requestId).toMatch(/^mcp-request:[0-9a-f-]{36}$/u);
      expect(diagnosticEvents(logs)).toEqual([
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
          issues: structuralIssues(UNKNOWN_WORKSPACE_ID_ISSUES),
        },
      ]);
      expect(logs.join("\n")).not.toContain(SECRET_VALUE);
      expect(logs.join("\n")).not.toContain(target.token);
      expect(target.audit).toEqual([]);
    });

    it("never echoes invalid values or reports a declared property as unknown", async () => {
      const target = harness({ kind: "oauth", clientId: GENERIC_CLIENT_ID });
      const logs = captureInfoLogs();
      const response = await rawCall(
        target,
        toolCall("skills_list", {
          workspace: { id: WORKSPACE.id },
          limit: BOUND_VIOLATION,
          visibility: [SECRET_VALUE],
        }),
      );
      const { body, error } = await protocolToolError(response);
      expect(error.details.issues).toEqual(DECLARED_VALUE_ISSUES);
      const events = diagnosticEvents(logs);
      expect(events).toHaveLength(1);
      expect(events[0]?.issues).toEqual(structuralIssues(DECLARED_VALUE_ISSUES));
      for (const text of [body, logs.join("\n")]) {
        expect(text).not.toContain(String(BOUND_VIOLATION));
        expect(text).not.toContain(SECRET_VALUE);
        expect(text).not.toContain('"rejectedProperty":"limit"');
        expect(text).not.toContain('"rejectedProperty": "limit"');
      }
      expect(target.workspaceReads).toEqual([]);
    });

    it("diagnoses an unroutable discovery call at the gateway without reaching a cell", async () => {
      const gateway = harness(
        { kind: "oauth", clientId: CLAUDE_MCP_CLIENT_ID },
        { databaseRole: "control" },
      );
      const routed = createRoutedMcpApplication({
        local: gateway.app,
        services: async () => gateway.services,
      });
      const bindings = gatewayBindings(() => {
        throw new Error("An unroutable call must not reach a cell");
      });
      for (const [args, issues] of [
        [{ workspace_id: SECRET_VALUE }, UNKNOWN_WORKSPACE_ID_ISSUES],
        [{}, UNKNOWN_WORKSPACE_ID_ISSUES.slice(1)],
      ] as const) {
        for (const [tool, extra] of [
          ["skills_list", {}],
          ["skills_search", { query: "review" }],
        ] as const) {
          vi.restoreAllMocks();
          const logs = captureInfoLogs();
          const response = await routed.fetch(
            mcpRequest(gateway.token, toolCall(tool, { ...args, ...extra })),
            bindings,
          );
          expect(response.status).toBe(200);
          const requestId = response.headers.get("x-skillplane-request-id");
          expect(requestId).toMatch(/^mcp-request:[0-9a-f-]{36}$/u);
          const { body, error } = await protocolToolError(response);
          expect(error.code).toBe("MCPFN_INVALID_ARGUMENTS");
          expect(error.details.issues).toEqual(issues);
          expect(body).not.toContain(SECRET_VALUE);
          expect(diagnosticEvents(logs)).toEqual([
            expect.objectContaining({
              requestId,
              tool,
              profileId: `${OAUTH_CLIENT_PROFILES.claude.id}@1`,
              stage: "input-validation",
              issues: structuralIssues(issues),
            }),
          ]);
          expect(logs.join("\n")).not.toContain(SECRET_VALUE);
        }
      }
      expect(gateway.workspaceReads).toEqual([]);
      expect(gateway.audit).toEqual([]);

      // Authentication still precedes any diagnostic.
      const logs = captureInfoLogs();
      const anonymous = await routed.fetch(
        mcpRequest(null, toolCall("skills_list", { workspace_id: SECRET_VALUE })),
        bindings,
      );
      expect(anonymous.status).toBe(401);
      expect(anonymous.headers.get("www-authenticate")).toContain("Bearer");
      expect(diagnosticEvents(logs)).toEqual([]);
    });

    it("returns the owning cell's diagnostic and correlation through the gateway", async () => {
      const principal = { kind: "oauth", clientId: GENERIC_CLIENT_ID } as const;
      const gateway = harness(principal, { databaseRole: "control" });
      const cell = harness(principal, { databaseRole: "regional" });
      const forwarded: Request[] = [];
      const routed = createRoutedMcpApplication({
        local: gateway.app,
        services: async () => gateway.services,
      });
      const logs = captureInfoLogs();
      const response = await routed.fetch(
        mcpRequest(
          gateway.token,
          toolCall("skills_list", {
            workspace: { id: WORKSPACE.id },
            limit: BOUND_VIOLATION,
            visibility: [SECRET_VALUE],
          }),
        ),
        gatewayBindings(async (request) => {
          forwarded.push(request);
          return await cell.app.fetch(request);
        }),
      );
      expect(forwarded).toHaveLength(1);
      expect(forwarded[0]?.headers.get("x-skillplane-routed-workspace-id")).toBe(
        WORKSPACE.id,
      );
      const requestId = response.headers.get("x-skillplane-request-id");
      expect(requestId).toMatch(/^mcp-request:[0-9a-f-]{36}$/u);
      const { body, error } = await protocolToolError(response);
      expect(error.details.issues).toEqual(DECLARED_VALUE_ISSUES);
      expect(body).not.toContain(String(BOUND_VIOLATION));
      expect(diagnosticEvents(logs)).toEqual([
        expect.objectContaining({
          requestId,
          tool: "skills_list",
          issues: structuralIssues(DECLARED_VALUE_ISSUES),
        }),
      ]);
      expect(gateway.workspaceReads).toEqual([]);
      expect(cell.workspaceReads).toEqual([]);
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
        const validate = createSchemaCompiler(engine).compile(
          incident.effectiveInputSchema,
        );
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
        expect(target.audit[0]?.caller).toMatchObject(
          OAUTH_CLIENT_PROFILES.claude.caller,
        );
        await client.close();
      });
    });
  });
}
