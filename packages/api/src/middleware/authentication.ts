import { AUTH_CSRF_HEADER, AUTH_SESSION_COOKIE, readCsrfToken } from "@skillplane/auth";
import { DomainError } from "@skillplane/domain";
import type { MiddlewareHandler } from "hono";
import type { ApiEnvironment, ApiServiceProvider } from "../context.js";
import { authenticateServicePrincipalRequest } from "../service-principal-auth.js";
import { ensurePersonalWorkspace } from "../tenancy.js";
import { initialWorkspaceRegionForRequest } from "../workspace-placement.js";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export function requiresPersonalWorkspace(path: string): boolean {
  return path.startsWith("/api/v1/") || path.startsWith("/datafn/");
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
    try {
      context.set("services", services);
      const serviceAuthentication = await authenticateServicePrincipalRequest(
        context.req.raw,
        services,
      );
      const servicePrincipal = serviceAuthentication?.principal ?? null;
      context.set("servicePrincipal", servicePrincipal);
      const session = servicePrincipal
        ? null
        : await services.auth.provider.authenticate(context.req.raw);
      context.set("session", session);
      if (session && requiresPersonalWorkspace(context.req.path)) {
        await ensurePersonalWorkspace(services.controlDatabase.pool, session, () =>
          initialWorkspaceRegionForRequest(context.req.raw, services, session.actorId),
        );
      }
      enforceCookieCsrf(context.req.raw, Boolean(session), Boolean(servicePrincipal));
      await next();
    } finally {
      try {
        await getServices.release?.(services);
      } catch {
        console.error(
          JSON.stringify({
            component: "api",
            event: "api.services.release.failed",
          }),
        );
      }
    }
  };
}
