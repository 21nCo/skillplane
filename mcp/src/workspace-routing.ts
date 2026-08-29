import {
  createPostgresResourceRoutingDirectory,
  createPostgresRoutingReplayStore,
  createPostgresWorkspacePlacementDirectory,
  createRegionalWorkspaceGuard,
  createWorkspaceGateway,
  createWorkspaceRoutingAssertions,
  logWorkspaceRoutingEvent,
} from "@skillplane/control-plane";
import { parseRuntimeConfig, type RuntimeBindings } from "@skillplane/config";
import type { ApiServiceProvider, ApiServices } from "@skillplane/api";
import {
  authenticateMcpRequest,
  McpAuthenticationError,
  mcpAuthenticationResponse,
  type McpIdentity,
} from "./auth.js";
import { verifyDownloadGrant } from "./downloads.js";

interface McpApplication<Context = unknown> {
  fetch(
    request: Request,
    bindings: RuntimeBindings,
    context?: Context,
  ): Response | Promise<Response>;
}

interface ServiceBinding {
  fetch(request: Request): Response | Promise<Response>;
}

type McpScope =
  | { readonly kind: "global" }
  | {
      readonly kind: "workspace-id";
      readonly value: string;
      readonly allowPublic: false;
    }
  | {
      readonly kind: "workspace-slug";
      readonly value: string;
      readonly allowPublic: false;
    }
  | { readonly kind: "skill-id"; readonly value: string; readonly allowPublic: boolean }
  | {
      readonly kind: "skill-slug";
      readonly workspaceSlug: string;
      readonly skillSlug: string;
      readonly allowPublic: boolean;
    }
  | {
      readonly kind: "download-grant";
      readonly token: string;
      readonly allowPublic: true;
    };

interface ResolvedMcpRoute {
  readonly workspaceId: string;
  readonly skillId?: string;
}

class McpRoutingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }

  response(): Response {
    return Response.json(
      { error: this.code, error_description: this.message },
      { status: this.status, headers: { "cache-control": "no-store" } },
    );
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function identifier(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 200
    ? value
    : null;
}

function downloadToken(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const decoded = decodeURIComponent(value);
    return decoded.length <= 8_192 && /^[A-Za-z0-9_.-]+$/u.test(decoded)
      ? decoded
      : null;
  } catch {
    return null;
  }
}

function scopeForMessage(message: unknown): McpScope {
  const root = record(message);
  const params = record(root?.params);
  if (root?.method !== "tools/call" || typeof params?.name !== "string") {
    return { kind: "global" };
  }
  if (params.name === "workspaces_list") return { kind: "global" };
  const arguments_ = record(params.arguments);
  const allowPublic =
    params.name === "skill_asset_retrieve" ||
    params.name === "skill_versions_list" ||
    (params.name === "skill_retrieve" && !record(arguments_?.context));
  const workspace = record(arguments_?.workspace);
  const workspaceId = identifier(workspace?.id) ?? identifier(arguments_?.workspaceId);
  if (workspaceId) {
    return { kind: "workspace-id", value: workspaceId, allowPublic: false };
  }
  const workspaceSlug = identifier(workspace?.slug);
  if (workspaceSlug) {
    return { kind: "workspace-slug", value: workspaceSlug, allowPublic: false };
  }
  const skill = record(arguments_?.skill);
  const skillId = identifier(skill?.id) ?? identifier(arguments_?.skillId);
  if (skillId) return { kind: "skill-id", value: skillId, allowPublic };
  const skillWorkspaceSlug = identifier(skill?.workspaceSlug);
  const skillSlug = identifier(skill?.skillSlug);
  if (skillWorkspaceSlug && skillSlug) {
    return {
      kind: "skill-slug",
      workspaceSlug: skillWorkspaceSlug,
      skillSlug,
      allowPublic,
    };
  }
  throw new McpRoutingError(
    400,
    "WORKSPACE_ROUTE_INVALID",
    "The MCP tool call does not identify one workspace",
  );
}

export async function classifyMcpScope(request: Request): Promise<McpScope> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname.startsWith("/downloads/")) {
    const parts = url.pathname.split("/");
    const token = downloadToken(parts.length === 3 ? parts[2] : undefined);
    if (!token) {
      throw new McpRoutingError(
        400,
        "WORKSPACE_ROUTE_INVALID",
        "The download route is invalid",
      );
    }
    return { kind: "download-grant", token, allowPublic: true };
  }
  if (request.method !== "POST" || url.pathname !== "/mcp") {
    return { kind: "global" };
  }
  let body: unknown;
  try {
    body = await request.clone().json();
  } catch {
    return { kind: "global" };
  }
  const scopes = (Array.isArray(body) ? body : [body]).map(scopeForMessage);
  const workspaceScopes = scopes.filter(
    (scope): scope is Exclude<McpScope, { readonly kind: "global" }> =>
      scope.kind !== "global",
  );
  if (workspaceScopes.length === 0) return { kind: "global" };
  if (workspaceScopes.length !== scopes.length) {
    throw new McpRoutingError(
      400,
      "WORKSPACE_BATCH_INVALID",
      "An MCP batch cannot mix global and workspace operations",
    );
  }
  const first = JSON.stringify(workspaceScopes[0]);
  if (workspaceScopes.some((scope) => JSON.stringify(scope) !== first)) {
    throw new McpRoutingError(
      400,
      "WORKSPACE_BATCH_INVALID",
      "An MCP batch cannot span multiple workspaces",
    );
  }
  const firstScope = workspaceScopes[0];
  if (!firstScope) return { kind: "global" };
  return firstScope;
}

async function resolveWorkspaceId(
  scope: Exclude<McpScope, { readonly kind: "global" }>,
  services: ApiServices,
): Promise<ResolvedMcpRoute> {
  if (scope.kind === "workspace-id") return { workspaceId: scope.value };
  if (scope.kind === "download-grant") {
    const grant = await verifyDownloadGrant(
      scope.token,
      services.auth.oauth.tokenPepper,
      new Date(),
    );
    return { workspaceId: grant.workspaceId, skillId: grant.skillId };
  }
  if (scope.kind === "skill-id") {
    const route = await createPostgresResourceRoutingDirectory(
      services.controlDatabase.pool,
    ).resolve("skill", scope.value);
    if (route) return { workspaceId: route.workspaceId, skillId: scope.value };
  } else {
    const slug = scope.kind === "workspace-slug" ? scope.value : scope.workspaceSlug;
    const result = await services.controlDatabase.pool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE slug = $1 LIMIT 1",
      [slug],
    );
    if (result.rows[0]) return { workspaceId: result.rows[0].id };
  }
  throw new McpRoutingError(
    404,
    "WORKSPACE_ROUTE_NOT_FOUND",
    "The workspace route was not found",
  );
}

async function authorizeWorkspace(
  identity: McpIdentity,
  scope: Exclude<McpScope, { readonly kind: "global" }>,
  route: ResolvedMcpRoute,
  services: ApiServices,
): Promise<void> {
  const { workspaceId } = route;
  const publicProjectionExists = async (): Promise<boolean> => {
    if (!scope.allowPublic) return false;
    const result = await services.controlDatabase.pool.query(
      scope.kind === "skill-id" || scope.kind === "download-grant"
        ? `SELECT 1 FROM public_skill_projections
             WHERE workspace_id = $1 AND skill_id = $2 AND state = 'published'
             LIMIT 1`
        : `SELECT 1 FROM public_skill_projections
             WHERE workspace_id = $1 AND workspace_slug = $2
               AND skill_slug = $3 AND state = 'published'
             LIMIT 1`,
      scope.kind === "skill-id" || scope.kind === "download-grant"
        ? [workspaceId, scope.kind === "skill-id" ? scope.value : route.skillId]
        : [workspaceId, scope.workspaceSlug, scope.skillSlug],
    );
    return Boolean(result.rows[0]);
  };
  if (identity.kind === "service") {
    if (identity.workspaceId !== workspaceId) {
      if (await publicProjectionExists()) return;
      throw new McpRoutingError(
        403,
        "WORKSPACE_ACCESS_DENIED",
        "Workspace access is denied",
      );
    }
    return;
  }
  const membership = await services.controlDatabase.pool.query<{ present: number }>(
    `SELECT 1 AS present
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, identity.userId],
  );
  if (!membership.rows[0]) {
    if (await publicProjectionExists()) return;
    throw new McpRoutingError(
      403,
      "WORKSPACE_ACCESS_DENIED",
      "Workspace access is denied",
    );
  }
}

function serviceBinding(value: unknown): ServiceBinding | null {
  return value &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function"
    ? (value as ServiceBinding)
    : null;
}

function cleanPublicRequest(request: Request): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-skillplane-routed-workspace-id");
  headers.delete("x-skillplane-routing-region");
  headers.delete("x-skillplane-routing-epoch");
  headers.delete("x-datafn-routing-assertion");
  return new Request(request, { headers });
}

/** Routes authenticated workspace tool calls to a private regional MCP cell. */
export function createRoutedMcpApplication<Context>(input: {
  readonly local: McpApplication<Context>;
  readonly services: ApiServiceProvider;
}): McpApplication<Context> {
  return {
    async fetch(incoming, bindings, context) {
      const runtime = parseRuntimeConfig(bindings, { authentication: "oauth-only" });
      const request =
        runtime.deployment.role === "cell" ? incoming : cleanPublicRequest(incoming);
      if (runtime.deployment.role === "single") {
        return await input.local.fetch(request, bindings, context);
      }
      try {
        const scope = await classifyMcpScope(request);
        if (runtime.deployment.role === "control") {
          return scope.kind === "global"
            ? await input.local.fetch(request, bindings, context)
            : new McpRoutingError(
                404,
                "CONTROL_ROUTE_NOT_FOUND",
                "The control-plane MCP route was not found",
              ).response();
        }
        if (runtime.deployment.role === "gateway") {
          if (scope.kind === "global") {
            return await input.local.fetch(request, bindings, context);
          }
          const services = await input.services(bindings);
          try {
            const identity = await authenticateMcpRequest(request, services);
            const route = await resolveWorkspaceId(scope, services);
            const workspaceId = route.workspaceId;
            await authorizeWorkspace(identity, scope, route, services);
            const assertions = createWorkspaceRoutingAssertions({
              activeKeyId: runtime.routing.activeKeyId,
              keys: runtime.routing.keys,
            });
            return await createWorkspaceGateway({
              directory: createPostgresWorkspacePlacementDirectory(
                services.controlDatabase.pool,
              ),
              resolveAuthorizedWorkspace: () => Promise.resolve(workspaceId),
              cells: {
                resolve: ({ regionId }) => {
                  const cell = runtime.deployment.topology.cells.find(
                    (candidate) => candidate.regionId === regionId,
                  );
                  const binding = cell
                    ? serviceBinding(bindings[cell.mcpServiceBinding])
                    : null;
                  if (!cell || !binding) throw new Error("regional MCP unavailable");
                  return {
                    regionId,
                    fetch: (forwarded) => Promise.resolve(binding.fetch(forwarded)),
                  };
                },
              },
              signer: assertions,
              assertionAudience: runtime.routing.audience,
              assertionTtlMs: runtime.routing.ttlMs,
              onEvent: (event) => logWorkspaceRoutingEvent("mcp", event),
            }).handle(request);
          } finally {
            await input.services.release?.(services);
          }
        }
        if (scope.kind === "global" || !runtime.deployment.regionId) {
          throw new McpRoutingError(
            404,
            "REGIONAL_ROUTE_NOT_FOUND",
            "The regional MCP route was not found",
          );
        }
        const workspaceId = request.headers.get("x-skillplane-routed-workspace-id");
        if (!workspaceId) {
          throw new McpRoutingError(
            401,
            "WORKSPACE_ROUTING_ASSERTION_REQUIRED",
            "A trusted workspace routing assertion is required",
          );
        }
        const services = await input.services(bindings);
        try {
          const assertions = createWorkspaceRoutingAssertions({
            activeKeyId: runtime.routing.activeKeyId,
            keys: runtime.routing.keys,
          });
          const authorized = await createRegionalWorkspaceGuard({
            regionId: runtime.deployment.regionId,
            directory: createPostgresWorkspacePlacementDirectory(
              services.controlDatabase.pool,
            ),
            verifier: assertions,
            replayStore: createPostgresRoutingReplayStore(
              services.controlDatabase.pool,
            ),
            assertionAudience: runtime.routing.audience,
            onEvent: (event) => logWorkspaceRoutingEvent("mcp", event),
          }).authorize(request, workspaceId);
          return await input.local.fetch(authorized.request, bindings, context);
        } finally {
          await input.services.release?.(services);
        }
      } catch (error) {
        if (error instanceof McpAuthenticationError) {
          return mcpAuthenticationResponse(null, error);
        }
        if (error instanceof McpRoutingError) return error.response();
        if (
          error &&
          typeof error === "object" &&
          "toResponse" in error &&
          typeof (error as { toResponse?: unknown }).toResponse === "function"
        ) {
          return (error as { toResponse(): Response }).toResponse();
        }
        return new McpRoutingError(
          503,
          "WORKSPACE_ROUTING_UNAVAILABLE",
          "Workspace routing is temporarily unavailable",
        ).response();
      }
    },
  };
}
