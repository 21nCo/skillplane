import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  createApiServiceProvider,
  type ApiServiceProvider,
  type ApiServices,
} from "@skillplane/api";
import { metadataResponse, protectedResourceMetadata } from "@skillplane/auth";
import type { RuntimeBindings } from "@skillplane/config";
import { McpToolError } from "@skillplane/mcp-schema";
import { normalizeBundlePath } from "@skillplane/storage";
import { Hono } from "hono";
import {
  authenticateMcpRequest,
  McpAuthenticationError,
  mcpAuthenticationResponse,
  type McpIdentity,
} from "./auth.js";
import {
  persistMcpAudit,
  PostgresMcpAuditWriter,
  type McpAuditWriter,
} from "./audit.js";
import { verifyDownloadGrant } from "./downloads.js";
import { McpCursorCodec } from "./pagination.js";
import { createSkillplaneMcpServer } from "./server.js";
import { resolveSkill, resolveVersion } from "./tools/resolve.js";
import { loadExactCanonicalBundle } from "./tools/retrieve.js";
import {
  mapMcpToolError,
  type McpToolRuntime,
  type ToolAuditScope,
  type ToolExecution,
} from "./tools/shared.js";

const MCP_ISSUER = "https://app.skillplane.dev";
const MCP_RESOURCE = "https://mcp.skillplane.dev/mcp";

interface McpEnvironment {
  Bindings: RuntimeBindings;
}

export interface CreateMcpAppOptions {
  readonly getServices?: ApiServiceProvider;
  readonly createAuditWriter?: (services: ApiServices) => McpAuditWriter;
  readonly now?: () => Date;
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

function createRuntime(
  services: ApiServices,
  identity: McpIdentity,
  audit: McpAuditWriter,
  request: Request,
  now: () => Date,
): McpToolRuntime {
  return {
    services,
    identity,
    audit,
    cursors: new McpCursorCodec(services.tenancySecret, now),
    downloadSecret: services.auth.oauth.tokenPepper,
    origin: new URL(request.url).origin,
    now,
  };
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
  const writer = new WeakMap<ApiServices, McpAuditWriter>();
  const auditFor = (services: ApiServices): McpAuditWriter => {
    const existing = writer.get(services);
    if (existing) return existing;
    const created =
      options.createAuditWriter?.(services) ??
      new PostgresMcpAuditWriter(services.database.pool);
    writer.set(services, created);
    return created;
  };

  const metadata = protectedResourceMetadata({
    issuer: MCP_ISSUER,
    resource: MCP_RESOURCE,
  });
  app.get("/.well-known/oauth-protected-resource", () => metadataResponse(metadata));
  app.get("/.well-known/oauth-protected-resource/mcp", () =>
    metadataResponse(metadata),
  );

  app.all("/mcp", async (context) => {
    let services: ApiServices | null = null;
    try {
      services = await getServices(context.env);
      const identity = await authenticateMcpRequest(context.req.raw, services);
      if (context.req.header("mcp-session-id")) {
        return jsonError(
          400,
          "invalid_session",
          "Skillplane uses stateless Streamable HTTP sessions",
        );
      }
      const runtime = createRuntime(
        services,
        identity,
        auditFor(services),
        context.req.raw,
        now,
      );
      const server = createSkillplaneMcpServer(runtime);
      const transport = new WebStandardStreamableHTTPServerTransport({
        enableJsonResponse: true,
      });
      await server.connect(transport);
      return secureProtocolResponse(await transport.handleRequest(context.req.raw));
    } catch (error) {
      if (error instanceof McpAuthenticationError) {
        return mcpAuthenticationResponse(services, error);
      }
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

export const app = createMcpApp();

interface WorkerHandler<Bindings> {
  fetch(
    request: Request,
    environment: Bindings,
    context: {
      waitUntil(promise: Promise<unknown>): void;
      passThroughOnException(): void;
    },
  ): Response | Promise<Response>;
}

export default {
  fetch(request, environment) {
    return app.fetch(request, environment);
  },
} satisfies WorkerHandler<RuntimeBindings>;
