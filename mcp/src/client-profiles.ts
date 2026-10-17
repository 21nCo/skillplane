import type {
  McpFnClientProfile,
  McpFnClientProfileEvidence,
  McpFnClientProfilesOptions,
  McpFnVerifiedClientIdentity,
} from "@mcpfn/core";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { CallerDeclaration } from "@skillplane/mcp-schema";
import { emitMcpDiagnosticEvent } from "./audit.js";
import type { McpIdentity } from "./auth.js";
import { SKILLPLANE_MCP_TOOL_NAMES } from "./tool-catalog.js";
import type { McpToolRuntime } from "./tools/shared.js";

export const LINEAR_MCP_CLIENT_ID =
  "https://linear.app/.well-known/oauth-client-metadata/mcp.json";
export const CLAUDE_MCP_CLIENT_ID = "https://claude.ai/oauth/mcp-oauth-client-metadata";

const PROFILE_VERSION = "1";
const MAX_VERIFIED_SUBJECT_LENGTH = 256;

type CallerTemplate = Omit<CallerDeclaration, "runId" | "sessionId" | "conversationId">;

export interface OAuthClientProfileDefinition {
  readonly id: string;
  readonly clientId: string | null;
  /** Linear rejects tools/list payloads above 32 KiB; see compactLinearToolCatalog. */
  readonly compactWireCatalog: boolean;
  readonly invocationPrefix: string;
  readonly caller: CallerTemplate;
}

export const OAUTH_CLIENT_PROFILES = {
  claude: {
    id: "skillplane/oauth-claude",
    clientId: CLAUDE_MCP_CLIENT_ID,
    compactWireCatalog: false,
    invocationPrefix: "claude",
    caller: {
      agentId: "claude",
      agentName: "Claude",
      modelProvider: "Anthropic",
      modelName: "Claude",
      modelVersion: "unknown",
      clientName: "Claude",
      clientVersion: "unknown",
    },
  },
  linear: {
    id: "skillplane/oauth-linear",
    clientId: LINEAR_MCP_CLIENT_ID,
    compactWireCatalog: true,
    invocationPrefix: "linear",
    caller: {
      agentId: "linear-agent",
      agentName: "Linear Agent",
      modelProvider: "Linear",
      modelName: "Linear Agent",
      modelVersion: "unknown",
      clientName: "Linear",
      clientVersion: "unknown",
    },
  },
  generic: {
    id: "skillplane/oauth-generic",
    clientId: null,
    compactWireCatalog: false,
    invocationPrefix: "oauth-client",
    caller: {
      agentId: "authenticated-oauth-client",
      agentName: "Authenticated OAuth client",
      modelProvider: "unknown",
      modelName: "unknown",
      modelVersion: "unknown",
      clientName: "OAuth MCP client",
      clientVersion: "unknown",
    },
  },
} as const satisfies Record<string, OAuthClientProfileDefinition>;

export const SERVICE_PRINCIPAL_PROFILE_ID = "skillplane/service-principal";

/** Selects an OAuth profile from an authenticated client ID, never from initialize metadata. */
export function oauthClientProfileFor(clientId: string): OAuthClientProfileDefinition {
  if (clientId === LINEAR_MCP_CLIENT_ID) return OAUTH_CLIENT_PROFILES.linear;
  if (clientId === CLAUDE_MCP_CLIENT_ID) return OAUTH_CLIENT_PROFILES.claude;
  return OAUTH_CLIENT_PROFILES.generic;
}

async function boundedSubject(value: string): Promise<string> {
  if (value.length <= MAX_VERIFIED_SUBJECT_LENGTH) return value;
  // Client ID metadata URLs may reach 2 KiB. A digest keeps the subject stable
  // and bounded; it can only ever select the generic profile.
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return `sha256:${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
}

export async function verifiedClientIdentity(
  identity: McpIdentity,
): Promise<McpFnVerifiedClientIdentity> {
  return identity.kind === "oauth"
    ? {
        subject: await boundedSubject(identity.clientId),
        attributes: { principal: "oauth" },
      }
    : {
        subject: await boundedSubject(identity.servicePrincipalId),
        attributes: { principal: "service" },
      };
}

/** Every Skillplane tool requires caller; OAuth profiles own it on every tool. */
export const OAUTH_SERVER_OWNED_ARGUMENTS: Readonly<Record<string, readonly string[]>> =
  Object.fromEntries(SKILLPLANE_MCP_TOOL_NAMES.map((name) => [name, ["caller"]]));

export function projectOAuthTool(tool: Tool): Tool {
  const properties = { ...tool.inputSchema.properties };
  delete properties.caller;
  const inputSchema: Tool["inputSchema"] = { ...tool.inputSchema, properties };
  const required = tool.inputSchema.required?.filter((name) => name !== "caller");
  if (required?.length) inputSchema.required = required;
  else delete inputSchema.required;
  return { ...tool, inputSchema };
}

export function oauthCaller(
  definition: OAuthClientProfileDefinition,
): CallerDeclaration {
  const invocationId = crypto.randomUUID();
  return {
    ...definition.caller,
    runId: `${definition.invocationPrefix}-run:${invocationId}`,
    sessionId: `${definition.invocationPrefix}-session:${invocationId}`,
    conversationId: `${definition.invocationPrefix}-conversation:${invocationId}`,
  };
}

function oauthProfile(
  definition: OAuthClientProfileDefinition,
): McpFnClientProfile<McpToolRuntime> {
  return {
    id: definition.id,
    version: PROFILE_VERSION,
    requiresReportedClient: false,
    matches: (verified) =>
      verified.attributes?.principal === "oauth" &&
      oauthClientProfileFor(verified.subject) === definition,
    serverOwnedArguments: OAUTH_SERVER_OWNED_ARGUMENTS,
    projectCatalog: ({ tools }) => tools.map(projectOAuthTool),
    enrichArguments: ({ arguments: args, context }) => {
      const identity = context.identity;
      // Attribution is derived only from the authenticated OAuth client. Without
      // that trusted context, McpFn fails closed with MCPFN_MISSING_TRUSTED_CONTEXT.
      if (
        identity.kind !== "oauth" ||
        oauthClientProfileFor(identity.clientId) !== definition
      ) {
        return args;
      }
      return { ...args, caller: oauthCaller(definition) };
    },
  };
}

/** Service principals declare caller themselves and receive the canonical catalog. */
const servicePrincipalProfile: McpFnClientProfile<McpToolRuntime> = {
  id: SERVICE_PRINCIPAL_PROFILE_ID,
  version: PROFILE_VERSION,
  requiresReportedClient: false,
  matches: (verified) => verified.attributes?.principal === "service",
};

export const SKILLPLANE_CLIENT_PROFILES: readonly McpFnClientProfile<McpToolRuntime>[] =
  [
    oauthProfile(OAUTH_CLIENT_PROFILES.claude),
    oauthProfile(OAUTH_CLIENT_PROFILES.linear),
    oauthProfile(OAUTH_CLIENT_PROFILES.generic),
    servicePrincipalProfile,
  ];

const PRE_HANDLER_STAGES = new Set<McpFnClientProfileEvidence["stage"]>([
  "profile-resolution",
  "catalog-projection",
  "argument-enrichment",
  "input-validation",
]);

/**
 * Turns McpFn lifecycle evidence into one redacted diagnostic per call that
 * fails before its handler. Evidence is structural, so values never reach it.
 */
export function skillplaneDiagnosticEvidence(input: {
  readonly requestId: string;
  readonly identity: McpIdentity;
}): (event: McpFnClientProfileEvidence) => void {
  return (event) => {
    if (event.outcome !== "failed" || !PRE_HANDLER_STAGES.has(event.stage)) return;
    emitMcpDiagnosticEvent({
      requestId: input.requestId,
      ...(event.tool ? { tool: event.tool } : {}),
      ...(event.profile
        ? { profileId: `${event.profile.id}@${event.profile.version}` }
        : {}),
      stage: event.stage,
      code: event.code ?? "MCPFN_TOOL_ERROR",
      actorType: input.identity.actorType,
      actorId: input.identity.actorId,
      issues: (event.issues ?? []).slice(0, 20),
    });
  };
}

export function skillplaneClientProfiles(
  evidence?: (event: McpFnClientProfileEvidence) => void,
): McpFnClientProfilesOptions<McpToolRuntime> {
  return {
    profiles: SKILLPLANE_CLIENT_PROFILES,
    resolveVerifiedIdentity: ({ context }) => verifiedClientIdentity(context.identity),
    ...(evidence ? { evidence } : {}),
  };
}

const LINEAR_OMITTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "description",
  "additionalProperties",
  "default",
  "exclusiveMaximum",
  "exclusiveMinimum",
  "format",
  "maxItems",
  "maxLength",
  "maximum",
  "minItems",
  "minLength",
  "minimum",
  "pattern",
]);

/** Keywords whose object values map property names, not keywords, to schemas. */
const SCHEMA_MAP_KEYWORDS = new Set([
  "$defs",
  "definitions",
  "dependentSchemas",
  "patternProperties",
  "properties",
]);

function compactLinearInputSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compactLinearInputSchema);
  if (!isJsonObject(value)) return value;
  const compacted: Record<string, unknown> = {};
  const enumerated = "enum" in value || "const" in value;
  for (const [key, child] of Object.entries(value)) {
    if (LINEAR_OMITTED_SCHEMA_KEYWORDS.has(key) || (enumerated && key === "type")) {
      continue;
    }
    compacted[key] =
      SCHEMA_MAP_KEYWORDS.has(key) && isJsonObject(child)
        ? Object.fromEntries(
            Object.entries(child).map(([name, schema]) => [
              name,
              compactLinearInputSchema(schema),
            ]),
          )
        : compactLinearInputSchema(child);
  }
  return compacted;
}

/**
 * Linear's 32 KiB tools/list budget cannot hold Skillplane's output schemas or
 * full input constraints, which McpFn projection must preserve. This wire step
 * runs after McpFn has produced the Linear effective catalog and only removes
 * presentation and constraint keywords: tool names, property names and required
 * sets are unchanged, and calls are still validated against the canonical schema.
 */
export function compactLinearToolCatalog(tools: readonly Tool[]): Tool[] {
  return tools.map((tool) => {
    const compacted: Tool = {
      ...tool,
      inputSchema: compactLinearInputSchema(tool.inputSchema) as Tool["inputSchema"],
    };
    if (tool.description !== undefined) {
      compacted.description =
        tool.title ?? tool.description.split(/(?<=\.)\s/u)[0]?.slice(0, 40);
    }
    delete compacted.outputSchema;
    delete compacted.execution;
    delete compacted.annotations;
    delete compacted.title;
    return compacted;
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function compactToolCatalogResponse(
  response: Response,
  identity: McpIdentity,
): Promise<Response> {
  if (
    identity.kind !== "oauth" ||
    !oauthClientProfileFor(identity.clientId).compactWireCatalog ||
    !response.headers.get("content-type")?.includes("application/json")
  ) {
    return response;
  }
  const body = await response.text();
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return new Response(body, response);
  }
  if (
    !isJsonObject(payload) ||
    !isJsonObject(payload.result) ||
    !Array.isArray(payload.result.tools)
  ) {
    return new Response(body, response);
  }
  payload.result.tools = compactLinearToolCatalog(payload.result.tools as Tool[]);
  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

const DEPRECATED_WORKSPACE_ID_TOOLS = new Set(["skills_list", "skills_search"]);

function normalizeToolCall(message: unknown, identity: McpIdentity): boolean {
  if (
    !isJsonObject(message) ||
    message.method !== "tools/call" ||
    !isJsonObject(message.params) ||
    !isJsonObject(message.params.arguments)
  ) {
    return false;
  }
  const args = message.params.arguments;
  let changed = false;
  // Deprecated alias: an unambiguous flat string workspaceId on discovery tools
  // becomes the canonical nested selector. Both forms together, or any other
  // spelling, are left for strict validation to reject.
  if (
    typeof message.params.name === "string" &&
    DEPRECATED_WORKSPACE_ID_TOOLS.has(message.params.name) &&
    !Object.hasOwn(args, "workspace") &&
    typeof args.workspaceId === "string"
  ) {
    args.workspace = { id: args.workspaceId };
    delete args.workspaceId;
    changed = true;
  }
  // OAuth clients cannot author caller provenance. Discarding a supplied value
  // lets the McpFn profile enrichment overwrite it instead of rejecting the call.
  if (identity.kind === "oauth" && Object.hasOwn(args, "caller")) {
    delete args.caller;
    changed = true;
  }
  return changed;
}

export interface PreparedMcpRequest {
  readonly request: Request;
  /**
   * Tool names when every message is a tools/call, otherwise null. Each
   * stateless McpFn server serves one HTTP request, so limiting its visible
   * catalog to these names is unobservable and avoids re-projecting the whole
   * catalog for every call.
   */
  readonly calledTools: ReadonlySet<string> | null;
}

function calledToolNames(messages: readonly unknown[]): ReadonlySet<string> | null {
  const names = new Set<string>();
  for (const message of messages) {
    if (
      !isJsonObject(message) ||
      message.method !== "tools/call" ||
      !isJsonObject(message.params) ||
      typeof message.params.name !== "string"
    ) {
      return null;
    }
    names.add(message.params.name);
  }
  return names.size > 0 ? names : null;
}

/**
 * Applies the two documented pre-validation rewrites (the deprecated discovery
 * workspaceId alias and the OAuth caller overwrite) to tools/call messages. All
 * other projection, enrichment and validation is owned by McpFn client profiles.
 */
export async function prepareMcpToolCallRequest(
  request: Request,
  identity: McpIdentity,
): Promise<PreparedMcpRequest> {
  if (
    request.method !== "POST" ||
    !request.headers.get("content-type")?.includes("application/json")
  ) {
    return { request, calledTools: null };
  }
  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return { request, calledTools: null };
  }
  const messages = Array.isArray(payload) ? payload : [payload];
  const calledTools = calledToolNames(messages);
  let changed = false;
  for (const message of messages) {
    if (normalizeToolCall(message, identity)) changed = true;
  }
  if (!changed) return { request, calledTools };
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return {
    request: new Request(request, { body: JSON.stringify(payload), headers }),
    calledTools,
  };
}
