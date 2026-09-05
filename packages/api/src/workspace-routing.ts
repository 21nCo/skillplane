import { DatafnRoutingError } from "@datafn/server";
import { parseRuntimeConfig, type RuntimeBindings } from "@skillplane/config";
import {
  createPostgresResourceRoutingDirectory,
  createPostgresRoutingReplayStore,
  createPostgresWorkspacePlacementDirectory,
  createRegionalWorkspaceGuard,
  createWorkspaceGateway,
  createWorkspaceRoutingAssertions,
  logWorkspaceRoutingEvent,
  type RoutableResourceType,
} from "@skillplane/control-plane";
import { InvalidAuthenticationError } from "@skillplane/domain";
import { collectDatafnStructuralResources } from "@skillplane/datafn";
import { authenticateServicePrincipalRequest } from "./service-principal-auth.js";
import type { ApiServiceProvider, ApiServices } from "./context.js";
import {
  recommendedWorkspaceRegionFromEdge,
  TRUSTED_WORKSPACE_REGION_HEADER,
} from "./workspace-placement.js";

interface FetchApplication {
  fetch(request: Request, bindings: RuntimeBindings): Response | Promise<Response>;
}

interface ServiceBinding {
  fetch(request: Request): Response | Promise<Response>;
}

const PUBLIC_SKILL_READ_HEADER = "x-skillplane-public-skill-read";

type ApiScope =
  | { readonly kind: "global" }
  | { readonly kind: "workspace"; readonly workspaceId: string | undefined }
  | {
      readonly kind: "resource";
      readonly resourceType: RoutableResourceType;
      readonly resourceId: string;
    };

type DatafnAuthority = "control" | "regional" | "mixed";
const controlDatafnResources = new Set(["workspaces", "workspaceMemberships"]);

export async function classifyDatafnAuthority(
  request: Request,
): Promise<DatafnAuthority | null> {
  if (!new URL(request.url).pathname.startsWith("/datafn/")) return null;
  let payload: unknown = null;
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      payload = await request.clone().json();
    } catch {
      return "regional";
    }
  }
  const resources = collectDatafnStructuralResources(payload);
  if (resources.size === 0) return "control";
  const control = [...resources].some((resource) =>
    controlDatafnResources.has(resource),
  );
  const regional = [...resources].some(
    (resource) => !controlDatafnResources.has(resource),
  );
  return control && regional ? "mixed" : control ? "control" : "regional";
}

class ApiRoutingError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ApiRoutingError";
    this.status = status;
    this.code = code;
  }

  response(): Response {
    return Response.json(
      {
        ok: false,
        error: { code: this.code, message: this.message },
      },
      {
        status: this.status,
        headers: { "cache-control": "no-store" },
      },
    );
  }
}

function segment(value: string | undefined): string {
  if (!value)
    throw new ApiRoutingError(
      404,
      "WORKSPACE_ROUTE_NOT_FOUND",
      "The workspace route was not found",
    );
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new ApiRoutingError(
      400,
      "WORKSPACE_ROUTE_INVALID",
      "The workspace route is invalid",
    );
  }
  let hasControlCharacter = false;
  for (const character of decoded) {
    if ((character.codePointAt(0) ?? 0) < 32) {
      hasControlCharacter = true;
      break;
    }
  }
  if (!decoded || decoded.length > 200 || hasControlCharacter) {
    throw new ApiRoutingError(
      400,
      "WORKSPACE_ROUTE_INVALID",
      "The workspace route is invalid",
    );
  }
  return decoded;
}

export function classifyApiScope(request: Request): ApiScope {
  const url = new URL(request.url);
  const path = url.pathname;
  if (path.startsWith("/datafn/")) {
    const workspaceId = request.headers.get("x-skillplane-workspace-id");
    return {
      kind: "workspace",
      workspaceId: workspaceId === null ? undefined : segment(workspaceId),
    };
  }
  let match = /^\/api\/v1\/workspaces\/([^/]+)\/skills(?:\/|$)/u.exec(path);
  if (match) return { kind: "workspace", workspaceId: segment(match[1]) };
  match = /^\/api\/v1\/(?:audit|analytics)\/workspaces\/([^/]+)(?:\/|$)/u.exec(path);
  if (match) return { kind: "workspace", workspaceId: segment(match[1]) };
  if (path === "/api/v1/skills/search") {
    const workspaceId =
      url.searchParams.get("workspaceId") ??
      request.headers.get("x-skillplane-workspace-id");
    return workspaceId
      ? { kind: "workspace", workspaceId: segment(workspaceId) }
      : { kind: "global" };
  }
  if (
    path.startsWith("/api/v1/skills/public") ||
    path.startsWith("/api/v1/stats/public")
  ) {
    return { kind: "global" };
  }
  match = /^\/api\/v1\/skills\/([^/]+)(?:\/|$)/u.exec(path);
  if (match) {
    return { kind: "resource", resourceType: "skill", resourceId: segment(match[1]) };
  }
  match = /^\/api\/v1\/contexts\/([^/]+)(?:\/|$)/u.exec(path);
  if (match) {
    return { kind: "resource", resourceType: "context", resourceId: segment(match[1]) };
  }
  match = /^\/api\/v1\/context-notes\/([^/]+)(?:\/|$)/u.exec(path);
  if (match) {
    return {
      kind: "resource",
      resourceType: "context_note",
      resourceId: segment(match[1]),
    };
  }
  return { kind: "global" };
}

async function resolveWorkspace(
  request: Request,
  scope: Exclude<ApiScope, { readonly kind: "global" }>,
  services: ApiServices,
  options: { readonly allowPublicRead?: boolean } = {},
): Promise<{ readonly workspaceId: string; readonly publicRead: boolean }> {
  let service: Awaited<ReturnType<typeof authenticateServicePrincipalRequest>>;
  try {
    service = await authenticateServicePrincipalRequest(request, services);
  } catch (error) {
    if (error instanceof InvalidAuthenticationError) {
      throw new ApiRoutingError(
        401,
        "AUTHENTICATION_INVALID",
        "Authentication is invalid",
      );
    }
    throw error;
  }
  const session = service ? null : await services.auth.provider.authenticate(request);
  if (!service && !session && !options.allowPublicRead) {
    throw new ApiRoutingError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required",
    );
  }
  const workspaceId =
    scope.kind === "workspace"
      ? scope.workspaceId
      : (
          await createPostgresResourceRoutingDirectory(
            services.controlDatabase.pool,
          ).resolve(scope.resourceType, scope.resourceId)
        )?.workspaceId;
  if (!workspaceId) {
    throw new ApiRoutingError(
      404,
      "WORKSPACE_ROUTE_NOT_FOUND",
      "The workspace route was not found",
    );
  }
  if (service) {
    if (service.principal.workspaceId !== workspaceId) {
      throw new ApiRoutingError(
        403,
        "WORKSPACE_ACCESS_DENIED",
        "Workspace access is denied",
      );
    }
    return { workspaceId, publicRead: false };
  }
  if (!session) {
    if (options.allowPublicRead) return { workspaceId, publicRead: true };
    throw new ApiRoutingError(
      401,
      "AUTHENTICATION_REQUIRED",
      "Authentication is required",
    );
  }
  const membership = await services.controlDatabase.pool.query<{ present: number }>(
    `SELECT 1 AS present
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, session.actorId],
  );
  if (!membership.rows[0]) {
    if (options.allowPublicRead) return { workspaceId, publicRead: true };
    throw new ApiRoutingError(
      403,
      "WORKSPACE_ACCESS_DENIED",
      "Workspace access is denied",
    );
  }
  return { workspaceId, publicRead: false };
}

function serviceBinding(value: unknown): ServiceBinding | null {
  return value &&
    typeof value === "object" &&
    "fetch" in value &&
    typeof (value as { fetch?: unknown }).fetch === "function"
    ? (value as ServiceBinding)
    : null;
}

function cleanPublicRequest(
  request: Request,
  recommendedWorkspaceRegion: string | null = null,
): Request {
  const headers = new Headers(request.headers);
  headers.delete("x-skillplane-routed-workspace-id");
  headers.delete("x-skillplane-routing-region");
  headers.delete("x-skillplane-routing-epoch");
  headers.delete("x-datafn-routing-assertion");
  headers.delete(PUBLIC_SKILL_READ_HEADER);
  headers.delete(TRUSTED_WORKSPACE_REGION_HEADER);
  if (recommendedWorkspaceRegion) {
    headers.set(TRUSTED_WORKSPACE_REGION_HEADER, recommendedWorkspaceRegion);
  }
  return new Request(request, { headers });
}

function isPublicSkillByIdRead(request: Request, scope: ApiScope): boolean {
  return (
    scope.kind === "resource" &&
    scope.resourceType === "skill" &&
    (request.method === "GET" || request.method === "HEAD") &&
    /^\/api\/v1\/skills\/[^/]+\/?$/u.test(new URL(request.url).pathname)
  );
}

function isPublicSkillVersionRead(request: Request, scope: ApiScope): boolean {
  return (
    scope.kind === "resource" &&
    scope.resourceType === "skill" &&
    (request.method === "GET" || request.method === "HEAD") &&
    /^\/api\/v1\/skills\/[^/]+\/versions(?:\/|$)/u.test(new URL(request.url).pathname)
  );
}

async function shouldUsePublicProjection(
  request: Request,
  scope: ApiScope,
  services: ApiServices,
): Promise<boolean> {
  if (!isPublicSkillByIdRead(request, scope)) return false;
  let service: Awaited<ReturnType<typeof authenticateServicePrincipalRequest>>;
  try {
    service = await authenticateServicePrincipalRequest(request, services);
  } catch (error) {
    // Let resolveWorkspace produce the stable authentication error response.
    if (error instanceof InvalidAuthenticationError) return false;
    throw error;
  }
  if (service) return false;
  const session = await services.auth.provider.authenticate(request);
  if (!session) return true;
  if (scope.kind !== "resource") return false;
  const route = await createPostgresResourceRoutingDirectory(
    services.controlDatabase.pool,
  ).resolve(scope.resourceType, scope.resourceId);
  if (!route) return true;
  const membership = await services.controlDatabase.pool.query<{ present: number }>(
    `SELECT 1 AS present
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [route.workspaceId, session.actorId],
  );
  return !membership.rows[0];
}

/** Canonical app edge: global routes terminate here; workspace routes use private service bindings. */
export function createRoutedApiApplication(input: {
  readonly local: FetchApplication;
  readonly services: ApiServiceProvider;
}): FetchApplication {
  return {
    async fetch(incoming, bindings) {
      const runtime = parseRuntimeConfig(
        bindings,
        bindings.SKILLPLANE_ROLE === "cell" ? { authentication: "oauth-only" } : {},
      );
      // Only public ingress is allowed to discard caller-supplied routing
      // metadata. Regional cells receive these headers from the trusted
      // service-binding hop and must retain them for assertion verification.
      const regionCandidates = runtime.deployment.topology.cells.map((cell) => ({
        regionId: cell.regionId,
        displayName: cell.placement?.displayName ?? cell.regionId,
        ...(cell.placement
          ? {
              latitude: cell.placement.latitude,
              longitude: cell.placement.longitude,
            }
          : {}),
      }));
      const recommendedWorkspaceRegion =
        runtime.deployment.role === "gateway"
          ? recommendedWorkspaceRegionFromEdge(incoming, regionCandidates)
          : null;
      const request =
        runtime.deployment.role === "cell"
          ? incoming
          : cleanPublicRequest(incoming, recommendedWorkspaceRegion);
      if (runtime.deployment.role === "single") {
        return await input.local.fetch(request, bindings);
      }
      const datafn = await classifyDatafnAuthority(request);
      if (datafn === "mixed") {
        return new ApiRoutingError(
          400,
          "DATAFN_AUTHORITY_MIXED",
          "A DataFn request cannot span control and regional resources",
        ).response();
      }
      if (runtime.deployment.role !== "cell" && datafn === "control") {
        return await input.local.fetch(request, bindings);
      }
      if (runtime.deployment.role === "cell" && datafn === "control") {
        return new ApiRoutingError(
          404,
          "REGIONAL_ROUTE_NOT_FOUND",
          "The regional route was not found",
        ).response();
      }
      let scope: ApiScope;
      try {
        scope = classifyApiScope(request);
      } catch (error) {
        if (error instanceof ApiRoutingError) return error.response();
        throw error;
      }
      if (runtime.deployment.role === "control") {
        return scope.kind === "global"
          ? await input.local.fetch(request, bindings)
          : new ApiRoutingError(
              404,
              "CONTROL_ROUTE_NOT_FOUND",
              "The control-plane route was not found",
            ).response();
      }
      if (runtime.deployment.role === "gateway") {
        if (scope.kind === "global") {
          return await input.local.fetch(request, bindings);
        }
        const services = await input.services(bindings);
        try {
          if (await shouldUsePublicProjection(request, scope, services)) {
            // The control-plane projection is authoritative for anonymous reads,
            // including authenticated callers who are not workspace members.
            // Member reads still route to the cell so private access is preserved.
            return await input.local.fetch(request, bindings);
          }
          const publicSkillVersionRead = isPublicSkillVersionRead(request, scope);
          const resolved = await resolveWorkspace(request, scope, services, {
            allowPublicRead: publicSkillVersionRead,
          });
          const forwardedRequest = resolved.publicRead
            ? new Request(request, { headers: new Headers(request.headers) })
            : request;
          if (resolved.publicRead) {
            forwardedRequest.headers.set(PUBLIC_SKILL_READ_HEADER, "1");
          }
          const assertions = createWorkspaceRoutingAssertions({
            activeKeyId: runtime.routing.activeKeyId,
            keys: runtime.routing.keys,
          });
          const gateway = createWorkspaceGateway({
            directory: createPostgresWorkspacePlacementDirectory(
              services.controlDatabase.pool,
            ),
            resolveAuthorizedWorkspace: () => Promise.resolve(resolved.workspaceId),
            cells: {
              resolve: ({ regionId }) => {
                const cell = runtime.deployment.topology.cells.find(
                  (candidate) => candidate.regionId === regionId,
                );
                const binding = cell
                  ? serviceBinding(bindings[cell.appServiceBinding])
                  : null;
                if (!cell || !binding) throw new Error("regional app unavailable");
                return {
                  regionId,
                  fetch: (forwarded) => Promise.resolve(binding.fetch(forwarded)),
                };
              },
            },
            signer: assertions,
            assertionAudience: runtime.routing.audience,
            assertionTtlMs: runtime.routing.ttlMs,
            onEvent: (event) => logWorkspaceRoutingEvent("app", event),
          });
          return await gateway.handle(forwardedRequest);
        } catch (error) {
          if (error instanceof ApiRoutingError) return error.response();
          if (error instanceof DatafnRoutingError) return error.toResponse();
          return new ApiRoutingError(
            503,
            "WORKSPACE_ROUTING_UNAVAILABLE",
            "Workspace routing is temporarily unavailable",
          ).response();
        } finally {
          await input.services.release?.(services);
        }
      }
      if (scope.kind === "global") {
        return new ApiRoutingError(
          404,
          "REGIONAL_ROUTE_NOT_FOUND",
          "The regional route was not found",
        ).response();
      }
      // DataFn performs the same framework validation inside its own router.
      if (new URL(request.url).pathname.startsWith("/datafn/")) {
        return await input.local.fetch(request, bindings);
      }
      const workspaceId = request.headers.get("x-skillplane-routed-workspace-id");
      if (!workspaceId || !runtime.deployment.regionId) {
        return new ApiRoutingError(
          401,
          "WORKSPACE_ROUTING_ASSERTION_REQUIRED",
          "A trusted workspace routing assertion is required",
        ).response();
      }
      const services = await input.services(bindings);
      try {
        const assertions = createWorkspaceRoutingAssertions({
          activeKeyId: runtime.routing.activeKeyId,
          keys: runtime.routing.keys,
        });
        const guard = createRegionalWorkspaceGuard({
          regionId: runtime.deployment.regionId,
          directory: createPostgresWorkspacePlacementDirectory(
            services.controlDatabase.pool,
          ),
          verifier: assertions,
          replayStore: createPostgresRoutingReplayStore(services.controlDatabase.pool),
          assertionAudience: runtime.routing.audience,
          onEvent: (event) => logWorkspaceRoutingEvent("app", event),
        });
        const authorized = await guard.authorize(request, workspaceId);
        return await input.local.fetch(authorized.request, bindings);
      } catch (error) {
        if (error instanceof DatafnRoutingError) return error.toResponse();
        return new ApiRoutingError(
          503,
          "WORKSPACE_ROUTING_UNAVAILABLE",
          "Workspace routing is temporarily unavailable",
        ).response();
      } finally {
        await input.services.release?.(services);
      }
    },
  };
}
