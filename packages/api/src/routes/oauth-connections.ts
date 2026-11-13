import { AUTH_SESSION_COOKIE, listConsents, revokeConsent } from "@skillplane/auth";
import { DomainError } from "@skillplane/domain";
import type { Context, Hono } from "hono";
import type { ApiEnvironment, ApiServices } from "../context.js";
import { success } from "../envelopes.js";

export const OAUTH_CONNECTIONS_PATH = "/api/v1/me/oauth-connections";

function hasSessionCookie(request: Request): boolean {
  return (request.headers.get("cookie") ?? "")
    .split(";")
    .some((entry) => entry.trim().startsWith(`${AUTH_SESSION_COOKIE}=`));
}

/**
 * OAuth connections belong to the person who granted them, so these routes
 * accept only that person's signed-in browser session. A cookie session is
 * required because the authentication middleware enforces the AuthFn CSRF
 * header for every unsafe `/api/v1` request that carries one. Service-principal
 * API keys, AuthFn API keys and bearer-only sessions are rejected.
 */
function browserSessionUser(context: Context<ApiEnvironment>): {
  readonly services: ApiServices;
  readonly userId: string;
} {
  const services = context.get("services");
  const session = context.get("session");
  if (context.get("servicePrincipal")) {
    throw new DomainError(
      "FORBIDDEN",
      "OAuth connections require a signed-in browser session",
      403,
    );
  }
  if (!services || !session) {
    throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
  }
  if (
    session.type !== "session" ||
    session.actorType !== "user" ||
    !hasSessionCookie(context.req.raw)
  ) {
    throw new DomainError(
      "FORBIDDEN",
      "OAuth connections require a signed-in browser session",
      403,
    );
  }
  return { services, userId: session.actorId };
}

export function registerOAuthConnectionRoutes(app: Hono<ApiEnvironment>): void {
  app.get(OAUTH_CONNECTIONS_PATH, async (context) => {
    const { services, userId } = browserSessionUser(context);
    const connections = await listConsents(services.auth.oauth, userId);
    return context.json(
      success(context, {
        connections: connections.map((connection) => ({
          consentId: connection.consentId,
          clientId: connection.clientId,
          clientName: connection.clientName,
          resource: connection.resource,
          scopes: connection.scopes,
          grantedAt: connection.grantedAt.toISOString(),
          lastTokenIssuedAt: connection.lastTokenIssuedAt?.toISOString() ?? null,
        })),
      }),
    );
  });

  app.delete(`${OAUTH_CONNECTIONS_PATH}/:consentId`, async (context) => {
    const { services, userId } = browserSessionUser(context);
    const result = await revokeConsent(services.auth.oauth, {
      userId,
      consentId: context.req.param("consentId"),
      requestId: context.get("requestId"),
    });
    if (result === "not_found") {
      throw new DomainError("NOT_FOUND", "The OAuth connection was not found", 404);
    }
    return context.body(null, 204);
  });
}
