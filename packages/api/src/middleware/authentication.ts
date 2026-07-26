import { AUTH_CSRF_HEADER, AUTH_SESSION_COOKIE, readCsrfToken } from "@skillplane/auth";
import {
  DomainError,
  InvalidAuthenticationError,
  assertServicePrincipalActive,
  isWorkspaceRole,
  type ServicePrincipal,
  type ServicePrincipalScope,
} from "@skillplane/domain";
import type { MiddlewareHandler } from "hono";
import type { ApiEnvironment, ApiServiceProvider } from "../context.js";
import { hashOpaqueToken } from "../tenancy-crypto.js";
import { ensurePersonalWorkspace } from "../tenancy.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

interface ServicePrincipalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly role: string;
  readonly scopes: string[];
  readonly delegated_user_id: string | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
}

async function authenticateServicePrincipal(
  authorization: string | undefined,
  services: Awaited<ReturnType<ApiServiceProvider>>,
): Promise<ServicePrincipal | null> {
  if (!authorization?.startsWith("Bearer sps_")) return null;
  const token = authorization.slice("Bearer ".length);
  const result = await services.database.pool.query<ServicePrincipalRow>(
    `SELECT id, workspace_id, name, role, scopes, delegated_user_id,
            expires_at, revoked_at
       FROM service_principals
      WHERE credential_hash = $1
      LIMIT 1`,
    [await hashOpaqueToken(token)],
  );
  const row = result.rows[0];
  if (
    !row ||
    !isWorkspaceRole(row.role) ||
    row.role === "owner" ||
    !Array.isArray(row.scopes)
  ) {
    throw new InvalidAuthenticationError();
  }
  assertServicePrincipalActive({
    revokedAt: row.revoked_at,
    expiresAt: row.expires_at,
    scopes: row.scopes as ServicePrincipalScope[],
  });
  await services.database.pool.query(
    "UPDATE service_principals SET last_used_at = now() WHERE id = $1",
    [row.id],
  );
  return {
    kind: "service",
    actorId: row.id,
    servicePrincipalId: row.id,
    workspaceId: row.workspace_id,
    displayName: row.name,
    role: row.role,
    scopes: row.scopes as ServicePrincipalScope[],
    ...(row.delegated_user_id ? { delegatedUserId: row.delegated_user_id } : {}),
  };
}

export function enforceCookieCsrf(
  request: Request,
  hasSession: boolean,
  hasServicePrincipal: boolean,
): void {
  const url = new URL(request.url);
  if (
    !hasSession ||
    hasServicePrincipal ||
    SAFE_METHODS.has(request.method) ||
    !url.pathname.startsWith("/api/v1/")
  ) {
    return;
  }
  const cookie = request.headers.get("cookie") ?? "";
  const bearerWithoutSessionCookie =
    request.headers.get("authorization")?.startsWith("Bearer ") === true &&
    !cookie
      .split(";")
      .some((entry) => entry.trim().startsWith(`${AUTH_SESSION_COOKIE}=`));
  if (bearerWithoutSessionCookie) return;
  const cookieToken = readCsrfToken(request.headers.get("cookie"));
  const headerToken = request.headers.get(AUTH_CSRF_HEADER);
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    throw new DomainError(
      "AUTH_CSRF_INVALID",
      "The request could not be verified",
      403,
    );
  }
}

export function authenticationMiddleware(
  getServices?: ApiServiceProvider,
): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    if (!getServices || context.req.path.startsWith("/api/v1/health/")) {
      context.set("services", null);
      context.set("session", null);
      context.set("servicePrincipal", null);
      await next();
      return;
    }
    const services = await getServices(context.env);
    context.set("services", services);
    const servicePrincipal = await authenticateServicePrincipal(
      context.req.header("authorization"),
      services,
    );
    context.set("servicePrincipal", servicePrincipal);
    const session = servicePrincipal
      ? null
      : await services.auth.provider.authenticate(context.req.raw);
    context.set("session", session);
    if (session) {
      await ensurePersonalWorkspace(services.database.pool, session);
    }
    enforceCookieCsrf(context.req.raw, Boolean(session), Boolean(servicePrincipal));
    await next();
  };
}
