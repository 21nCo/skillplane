import { createAuthProviderMcpHandler } from "@mcpfn/auth";
import {
  createApiServiceProvider,
  type ApiServiceProvider,
  type ApiServices,
} from "@skillplane/api";
import { metadataResponse, protectedResourceMetadata } from "@skillplane/auth";
import { parseOAuthEndpoints, type RuntimeBindings } from "@skillplane/config";
import { McpToolError } from "@skillplane/mcp-schema";
import { normalizeBundlePath } from "@skillplane/storage";
import { instrument, type PostHog } from "@posthog/mcp";
import { Hono } from "hono";
import appleTouchIcon from "./assets/apple-touch-icon.png";
import favicon from "./assets/favicon.ico";
import favicon32 from "./assets/favicon-32x32.png";
import icon192 from "./assets/icon-192.png";
import icon512 from "./assets/icon-512.png";
import gradientLogo from "./assets/skillplane-logo-gradient-transparent.png";
import {
  authenticateMcpBearerCredential,
  authenticateMcpRequest,
  McpAuthenticationError,
  mcpAuthenticationResponse,
  requiredScopesForRequest,
  type McpIdentity,
} from "./auth.js";
import {
  ControlPlaneMcpAuditWriter,
  persistMcpAudit,
  PostgresMcpAuditWriter,
  type McpAuditWriter,
} from "./audit.js";
import {
  createPostHogResolver,
  flushPostHog,
  isPostHogSessionId,
} from "./analytics.js";
import { verifyDownloadGrant } from "./downloads.js";
import { McpCursorCodec } from "./pagination.js";
import { createSkillplaneMcpServer } from "./server.js";
import { resolveSkill, resolveVersion } from "./tools/resolve.js";
import { loadExactCanonicalBundle } from "./tools/retrieve.js";
import { createRoutedMcpApplication } from "./workspace-routing.js";
import {
  mapMcpToolError,
  type McpToolRuntime,
  type ToolAuditScope,
  type ToolExecution,
} from "./tools/shared.js";

const MCP_ISSUER = "https://app.skillplane.dev";
const MCP_RESOURCE = "https://mcp.skillplane.dev/mcp";
const LINEAR_MCP_CLIENT_ID =
  "https://linear.app/.well-known/oauth-client-metadata/mcp.json";

const BRAND_CACHE_CONTROL = "public, max-age=604800, immutable";

const MCP_HOME = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b0c0f">
    <title>Skillplane MCP</title>
    <link rel="icon" href="/favicon.ico" sizes="32x32">
    <link rel="icon" href="/favicon-32x32.png" type="image/png" sizes="32x32">
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" sizes="180x180">
    <link rel="manifest" href="/site.webmanifest">
  </head>
  <body>
    <main>
      <img src="/skillplane-logo-gradient-transparent.png" width="160" height="160" alt="">
      <h1>Skillplane MCP</h1>
      <p>Connect at <code>https://mcp.skillplane.dev/mcp</code>.</p>
      <p><a href="https://skillplane.dev">Open Skillplane</a></p>
    </main>
  </body>
</html>`;

const MCP_MANIFEST = JSON.stringify({
  name: "Skillplane MCP",
  short_name: "Skillplane",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0c0f",
  theme_color: "#0b0c0f",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
  ],
});

interface McpEnvironment {
  Bindings: RuntimeBindings;
}

export interface CreateMcpAppOptions {
  readonly getServices?: ApiServiceProvider;
  readonly createAuditWriter?: (services: ApiServices) => McpAuditWriter;
  readonly now?: () => Date;
  readonly posthog?: PostHog | null;
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(
    JSON.stringify({
      error: code,
      error_description: message,
    }),
    {
      status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        pragma: "no-cache",
        "x-content-type-options": "nosniff",
      },
    },
  );
}

function secureProtocolResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  headers.set("referrer-policy", "no-referrer");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const LINEAR_OMITTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
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

function compactLinearInputSchema(value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) compactLinearInputSchema(item);
    return;
  }
  if (!isJsonObject(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (LINEAR_OMITTED_SCHEMA_KEYWORDS.has(key)) {
      value[key] = undefined;
    } else {
      compactLinearInputSchema(child);
    }
  }
}

export async function compactLinearToolCatalogResponse(
  response: Response,
  isLinearAgent: boolean,
): Promise<Response> {
  if (
    !isLinearAgent ||
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

  // Linear only needs names, descriptions, and input contracts. Keep optional
  // MCP presentation and output metadata server-side to stay within its budget.
  for (const tool of payload.result.tools) {
    if (!isJsonObject(tool)) continue;
    delete tool.outputSchema;
    delete tool.execution;
    delete tool.annotations;
    delete tool.title;
    if (isJsonObject(tool.inputSchema)) {
      if (isJsonObject(tool.inputSchema.properties)) {
        delete tool.inputSchema.properties.caller;
      }
      if (Array.isArray(tool.inputSchema.required)) {
        tool.inputSchema.required = tool.inputSchema.required.filter(
          (name) => name !== "caller",
        );
      }
      compactLinearInputSchema(tool.inputSchema);
    }
  }

  const headers = new Headers(response.headers);
  headers.delete("content-length");
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export async function withLinearAgentCaller(
  request: Request,
  isLinearAgent: boolean,
): Promise<Request> {
  if (
    !isLinearAgent ||
    request.method !== "POST" ||
    !request.headers.get("content-type")?.includes("application/json")
  ) {
    return request;
  }

  let payload: unknown;
  try {
    payload = await request.clone().json();
  } catch {
    return request;
  }
  if (
    !isJsonObject(payload) ||
    payload.method !== "tools/call" ||
    !isJsonObject(payload.params)
  ) {
    return request;
  }

  const arguments_ = isJsonObject(payload.params.arguments)
    ? payload.params.arguments
    : {};
  if (!isJsonObject(arguments_.caller)) {
    const invocationId = crypto.randomUUID();
    arguments_.caller = {
      agentId: "linear-agent",
      agentName: "Linear Agent",
      modelProvider: "Linear",
      modelName: "Linear Agent",
      modelVersion: "unknown",
      clientName: "Linear",
      clientVersion: "unknown",
      runId: `linear-run:${invocationId}`,
      sessionId: `linear-session:${invocationId}`,
      conversationId: `linear-conversation:${invocationId}`,
    };
  }
  payload.params.arguments = arguments_;

  const headers = new Headers(request.headers);
  headers.delete("content-length");
  return new Request(request, {
    body: JSON.stringify(payload),
    headers,
  });
}

function statelessMethodNotAllowedResponse(): Response {
  return secureProtocolResponse(
    new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Method not allowed.",
        },
        id: null,
      }),
      {
        status: 405,
        headers: {
          allow: "POST",
          "content-type": "application/json",
        },
      },
    ),
  );
}

function brandAssetResponse(body: ArrayBuffer, contentType: string): Response {
  return new Response(body, {
    headers: {
      "cache-control": BRAND_CACHE_CONTROL,
      "content-type": contentType,
      "x-content-type-options": "nosniff",
    },
  });
}

function createRuntime(
  services: ApiServices,
  identity: McpIdentity,
  audit: McpAuditWriter,
  request: Request,
  now: () => Date,
): McpToolRuntime {
  const fencingEpoch = Number(request.headers.get("x-skillplane-routing-epoch") ?? "1");
  if (!Number.isSafeInteger(fencingEpoch) || fencingEpoch < 1) {
    throw new McpToolError(
      "VALIDATION_FAILED",
      "The workspace routing epoch is invalid",
    );
  }
  return {
    services,
    identity,
    audit,
    cursors: new McpCursorCodec(services.tenancySecret, now),
    downloadSecret: services.auth.oauth.tokenPepper,
    origin: new URL(request.url).origin,
    fencingEpoch,
    now,
  };
}

interface SkillplaneMcpAuthSession {
  readonly id: string;
  readonly type: string;
  readonly subject: {
    readonly actorId: string;
    readonly actorType: string;
    readonly tenantId?: string;
  };
  readonly resourceIds: string[];
  readonly scopes: string[];
  readonly methods: string[];
  readonly expiresAt?: Date;
  readonly identity: McpIdentity;
}

function authSession(identity: McpIdentity): SkillplaneMcpAuthSession {
  return {
    id: identity.credentialId,
    type: identity.kind,
    subject: {
      actorId: identity.actorId,
      actorType: identity.actorType,
      ...(identity.kind === "service" ? { tenantId: identity.workspaceId } : {}),
    },
    resourceIds: identity.kind === "service" ? [identity.workspaceId] : [],
    scopes: [...identity.scopes],
    methods: [identity.credentialKind],
    ...(identity.kind === "oauth" ? { expiresAt: identity.expiresAt } : {}),
    identity,
  };
}

function authenticatedIdentity(authInfo: unknown): McpIdentity {
  if (!isJsonObject(authInfo) || !isJsonObject(authInfo.extra)) {
    throw new Error("McpFn did not propagate authenticated principal context");
  }
  const identity = authInfo.extra.skillplaneIdentity;
  if (
    !isJsonObject(identity) ||
    !["oauth", "service"].includes(String(identity.kind))
  ) {
    throw new Error("McpFn authenticated principal context is invalid");
  }
  return identity as unknown as McpIdentity;
}

function runtimeEnvironment(bindings: RuntimeBindings | undefined): string | undefined {
  return bindings?.RUNTIME_ENV;
}

function isAllowedMcpHost(
  request: Request,
  services: ApiServices,
  runtimeEnvironment: string | undefined,
): boolean {
  const rawHost = request.headers.get("host") ?? new URL(request.url).host;
  if (!rawHost) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${rawHost}`).hostname;
  } catch {
    return false;
  }
  if (hostname === new URL(services.auth.oauth.resource).hostname) return true;
  return (
    runtimeEnvironment !== "production" &&
    ["127.0.0.1", "[::1]", "localhost"].includes(hostname)
  );
}

async function handleDownload(
  request: Request,
  token: string,
  services: ApiServices,
  identity: McpIdentity,
  audit: McpAuditWriter,
  now: () => Date,
): Promise<Response> {
  const startedAt = performance.now();
  let scope: ToolAuditScope = {};
  let grant: Awaited<ReturnType<typeof verifyDownloadGrant>> | undefined;
  try {
    grant = await verifyDownloadGrant(token, services.auth.oauth.tokenPepper, now());
    scope = {
      workspaceId: grant.workspaceId,
      resourceType: "skill_version",
      resourceId: grant.versionId,
      skillId: grant.skillId,
      versionId: grant.versionId,
      versionDigest: grant.bundleDigest,
    };
    if (grant.credentialId !== identity.credentialId) {
      throw new McpToolError(
        "AUTH_INVALID",
        "The download grant is bound to another credential",
        { status: 401 },
      );
    }
    const runtime = createRuntime(services, identity, audit, request, now);
    const execution: ToolExecution = {
      requestId: grant.requestId,
      scope,
      setScope(values) {
        scope = { ...scope, ...values };
      },
    };
    const skill = await resolveSkill(
      runtime,
      execution,
      { id: grant.skillId },
      { action: "skills:read", allowPublic: true },
    );
    const version = await resolveVersion(runtime, execution, skill, {
      selector: "versionId",
      versionId: grant.versionId,
    });
    if (
      skill.workspaceId !== grant.workspaceId ||
      version.digest !== grant.bundleDigest
    ) {
      throw new McpToolError(
        "AUTH_INVALID",
        "The download grant no longer matches the resource",
        { status: 401 },
      );
    }
    const path = normalizeBundlePath(grant.path);
    const bundle = await loadExactCanonicalBundle(runtime, version);
    const bytes = bundle.files.get(path);
    const descriptor = bundle.manifest.files.find((file) => file.path === path);
    if (!bytes || descriptor?.sha256 !== grant.fileSha256) {
      throw new McpToolError(
        "R2_OBJECT_MISMATCH",
        "The stored asset no longer matches the download grant",
        { status: 503, retryable: true },
      );
    }
    await persistMcpAudit(audit, {
      workspaceId: skill.workspaceId,
      requestId: grant.requestId,
      tool: "skill_asset_download",
      outcome: "success",
      identity,
      caller: grant.caller,
      resourceType: "skill_version",
      resourceId: version.id,
      skillId: skill.id,
      versionId: version.id,
      versionDigest: version.digest,
      latencyMs: performance.now() - startedAt,
      countMetric: false,
    });
    const filename = path.split("/").at(-1) ?? "skill-asset";
    const body = new Uint8Array(bytes.byteLength);
    body.set(bytes);
    return new Response(body, {
      status: 200,
      headers: {
        "cache-control": "private, no-store",
        "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(
          filename,
        )}`,
        "content-security-policy": "sandbox; default-src 'none'",
        "content-type": descriptor.mediaType,
        "cross-origin-resource-policy": "same-origin",
        pragma: "no-cache",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (caught) {
    let error = mapMcpToolError(caught);
    if (grant && scope.workspaceId && error.code !== "AUDIT_WRITE_FAILED") {
      try {
        await persistMcpAudit(audit, {
          workspaceId: scope.workspaceId,
          requestId: grant.requestId,
          tool: "skill_asset_download",
          outcome:
            error.status === 401 || error.status === 403 || error.status === 404
              ? "denied"
              : "error",
          identity,
          caller: grant.caller,
          ...(scope.resourceType ? { resourceType: scope.resourceType } : {}),
          ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
          ...(scope.skillId ? { skillId: scope.skillId } : {}),
          ...(scope.versionId ? { versionId: scope.versionId } : {}),
          ...(scope.versionDigest ? { versionDigest: scope.versionDigest } : {}),
          errorCode: error.code,
          latencyMs: performance.now() - startedAt,
          countMetric: false,
        });
      } catch (auditError) {
        error = mapMcpToolError(auditError);
      }
    }
    return jsonError(error.status, error.code, error.message);
  }
}

export function createMcpApp(options: CreateMcpAppOptions = {}) {
  const app = new Hono<McpEnvironment>();
  const getServices =
    options.getServices ?? createApiServiceProvider({ authentication: "oauth-only" });
  const now = options.now ?? (() => new Date());
  const resolvePostHog = createPostHogResolver(options.posthog);
  const writer = new WeakMap<ApiServices, McpAuditWriter>();
  const auditFor = (services: ApiServices): McpAuditWriter => {
    const existing = writer.get(services);
    if (existing) return existing;
    const created =
      options.createAuditWriter?.(services) ??
      (services.database.role === "regional"
        ? new PostgresMcpAuditWriter(services.database.pool, true)
        : new ControlPlaneMcpAuditWriter(services.database.pool));
    writer.set(services, created);
    return created;
  };

  const metadata = (bindings: RuntimeBindings | undefined) =>
    protectedResourceMetadata(
      bindings?.RUNTIME_ENV
        ? parseOAuthEndpoints(bindings)
        : { issuer: MCP_ISSUER, resource: MCP_RESOURCE },
    );
  app.get("/.well-known/oauth-protected-resource", (context) =>
    metadataResponse(metadata(context.env)),
  );
  app.get("/.well-known/oauth-protected-resource/mcp", (context) =>
    metadataResponse(metadata(context.env)),
  );
  app.get(
    "/",
    () =>
      new Response(MCP_HOME, {
        headers: {
          "cache-control": "public, max-age=3600",
          "content-type": "text/html; charset=utf-8",
          "x-content-type-options": "nosniff",
        },
      }),
  );
  app.get("/favicon.ico", () => brandAssetResponse(favicon, "image/x-icon"));
  app.get("/favicon-32x32.png", () => brandAssetResponse(favicon32, "image/png"));
  app.get("/apple-touch-icon.png", () =>
    brandAssetResponse(appleTouchIcon, "image/png"),
  );
  app.get("/icon-192.png", () => brandAssetResponse(icon192, "image/png"));
  app.get("/icon-512.png", () => brandAssetResponse(icon512, "image/png"));
  app.get("/skillplane-logo-gradient-transparent.png", () =>
    brandAssetResponse(gradientLogo, "image/png"),
  );
  app.get(
    "/site.webmanifest",
    () =>
      new Response(MCP_MANIFEST, {
        headers: {
          "cache-control": BRAND_CACHE_CONTROL,
          "content-type": "application/manifest+json",
          "x-content-type-options": "nosniff",
        },
      }),
  );

  app.all("/mcp", async (context) => {
    let services: ApiServices | null = null;
    try {
      services = await getServices(context.env);
      const currentServices = services;
      if (
        !isAllowedMcpHost(
          context.req.raw,
          currentServices,
          runtimeEnvironment(context.env),
        )
      ) {
        return jsonError(421, "INVALID_HOST", "The MCP Host header is not allowed");
      }
      const handler = createAuthProviderMcpHandler(
        async (request, handleOptions) => {
          const identity = authenticatedIdentity(handleOptions?.authInfo);
          const sessionId = request.headers.get("mcp-session-id");
          // PostHog's token carries analytics correlation only; it does not
          // restore application or authorization state.
          if (sessionId && !isPostHogSessionId(sessionId)) {
            return jsonError(
              400,
              "invalid_session",
              "Skillplane uses stateless Streamable HTTP sessions",
            );
          }
          if (request.method !== "POST") {
            return statelessMethodNotAllowedResponse();
          }
          const isLinearAgent =
            identity.kind === "oauth" && identity.clientId === LINEAR_MCP_CLIENT_ID;
          const protocolRequest = await withLinearAgentCaller(request, isLinearAgent);
          const runtime = createRuntime(
            currentServices,
            identity,
            auditFor(currentServices),
            protocolRequest,
            now,
          );
          const server = createSkillplaneMcpServer(runtime);
          const posthog = resolvePostHog(context.env);
          const protocolHandler = await server.createWebStandardHandler({
            enableJsonResponse: true,
            ...(posthog
              ? {
                  configureRequestServer: (requestServer) => {
                    instrument(requestServer.protocol, posthog);
                  },
                }
              : {}),
          });
          const response = await protocolHandler(protocolRequest, handleOptions);
          const protocolResponse = secureProtocolResponse(
            await compactLinearToolCatalogResponse(response, isLinearAgent),
          );
          if (posthog) {
            let waitUntil: ((promise: Promise<unknown>) => void) | undefined;
            try {
              const executionContext = context.executionCtx;
              waitUntil = executionContext.waitUntil.bind(executionContext);
            } catch {
              // Hono's direct test helpers do not provide an execution context.
            }
            await flushPostHog(posthog, waitUntil);
          }
          return protocolResponse;
        },
        {
          resource: currentServices.auth.oauth.resource,
          provider: {
            authenticateBearer: async (token, request) => {
              try {
                return authSession(
                  await authenticateMcpBearerCredential(
                    token,
                    request,
                    currentServices,
                  ),
                );
              } catch (error) {
                if (error instanceof McpAuthenticationError && error.status === 401) {
                  return null;
                }
                throw error;
              }
            },
          },
          map: (session) => ({
            subject: session.identity.actorId,
            clientId:
              session.identity.kind === "oauth"
                ? session.identity.clientId
                : session.identity.servicePrincipalId,
            scopes: [...session.identity.scopes],
            resourceIds: [...session.resourceIds],
            ...(session.subject.tenantId ? { tenantId: session.subject.tenantId } : {}),
            ...(session.expiresAt
              ? { expiresAt: Math.floor(session.expiresAt.getTime() / 1_000) }
              : {}),
            authMethods: [...session.methods],
            extra: { skillplaneIdentity: session.identity },
          }),
          requiredScopes: async ({ request }) => [
            ...(await requiredScopesForRequest(request)),
          ],
        },
      );
      return await handler(context.req.raw);
    } catch {
      return jsonError(500, "INTERNAL_ERROR", "The MCP request could not be completed");
    } finally {
      if (services) {
        try {
          await getServices.release?.(services);
        } catch {
          console.error(
            JSON.stringify({
              component: "mcp",
              event: "mcp.services.release.failed",
            }),
          );
        }
      }
    }
  });

  app.get("/downloads/:grant", async (context) => {
    let services: ApiServices | null = null;
    try {
      services = await getServices(context.env);
      const identity = await authenticateMcpRequest(context.req.raw, services, [
        "skills:read",
      ]);
      return await handleDownload(
        context.req.raw,
        context.req.param("grant"),
        services,
        identity,
        auditFor(services),
        now,
      );
    } catch (error) {
      if (error instanceof McpAuthenticationError) {
        return mcpAuthenticationResponse(services, error);
      }
      return jsonError(500, "INTERNAL_ERROR", "The download could not be completed");
    } finally {
      if (services) {
        try {
          await getServices.release?.(services);
        } catch {
          console.error(
            JSON.stringify({
              component: "mcp",
              event: "mcp.services.release.failed",
            }),
          );
        }
      }
    }
  });

  app.notFound(() =>
    jsonError(404, "NOT_FOUND", "The requested MCP route was not found"),
  );
  return app;
}

const services = createApiServiceProvider({ authentication: "oauth-only" });
export const app = createMcpApp({ getServices: services });
const routedApp = createRoutedMcpApplication({ local: app, services });

interface WorkerHandler<Bindings> {
  fetch(
    request: Request,
    environment: Bindings,
    context: {
      waitUntil(promise: Promise<unknown>): void;
      passThroughOnException(): void;
      readonly props: unknown;
    },
  ): Response | Promise<Response>;
}

export default {
  fetch(request, environment, context) {
    return routedApp.fetch(request, environment, context);
  },
} satisfies WorkerHandler<RuntimeBindings>;
