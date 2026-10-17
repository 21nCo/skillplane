import {
  buildMcpFnEffectiveCatalog,
  enrichMcpFnClientProfileCall,
  type McpFnClientProfile,
  type McpFnListedTool,
} from "@mcpfn/core";
import {
  runMcpFnClientProfileContracts,
  type McpFnClientProfileContractCase,
} from "@mcpfn/testing";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { callerDeclarationSchema } from "@skillplane/mcp-schema";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpIdentity } from "./auth.js";
import {
  CLAUDE_MCP_CLIENT_ID,
  LINEAR_MCP_CLIENT_ID,
  prepareMcpToolCallRequest,
  OAUTH_CLIENT_PROFILES,
  SKILLPLANE_CLIENT_PROFILES,
  verifiedClientIdentity,
} from "./client-profiles.js";
import {
  appTarget,
  connect,
  DECLARED_CALLER,
  describeDiagnosticContract,
  GENERIC_CLIENT_ID,
  harness,
  oauthIdentity,
  rawCall,
  RESOURCE,
  runtimeFor,
  SERVICE_IDENTITY,
  toolError,
  WORKSPACE,
} from "../tests/support/client-profile-contract.js";
import { skillplaneMcpDeclaration } from "./server.js";
import { SKILLPLANE_MCP_TOOL_COUNT } from "./tool-catalog.js";
import type { McpToolRuntime } from "./tools/shared.js";

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

  it("never runs a workspace tool against control-plane data", async () => {
    const control = harness(
      { kind: "oauth", clientId: GENERIC_CLIENT_ID },
      { databaseRole: "control" },
    );
    const client = await connect(control);
    const refused = toolError(
      await client.callTool("skills_list", { workspace: { id: WORKSPACE.id } }),
    );
    expect(refused.error.code).toBe("VALIDATION_FAILED");
    expect(control.workspaceReads).toEqual([]);
    expect(control.audit).toEqual([]);
    const global = await client.callTool("workspaces_list", {});
    expect(global.isError, JSON.stringify(global)).not.toBe(true);
    await client.close();
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

describeDiagnosticContract("ajv");

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
