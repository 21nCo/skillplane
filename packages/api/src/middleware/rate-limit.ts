import { consumeRateLimit } from "@skillplane/db";
import type { MiddlewareHandler } from "hono";
import type { ApiEnvironment } from "../context.js";
import { failure } from "../envelopes.js";

export function rateLimitRouteKey(path: string): string {
  if (path.startsWith("/api/v1/invitations/")) {
    return path.endsWith("/accept")
      ? "/api/v1/invitations/:token/accept"
      : "/api/v1/invitations/:token";
  }
  return path;
}

export function rateLimitMiddleware(): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const services = context.get("services");
    if (!services) {
      await next();
      return undefined;
    }
    const session = context.get("session");
    const servicePrincipal = context.get("servicePrincipal");
    const forwarded = context.req.header("cf-connecting-ip") ?? "unknown";
    const decision = await consumeRateLimit(
      services.controlDatabase.pool,
      `${rateLimitRouteKey(context.req.path)}:${session?.actorId ?? servicePrincipal?.actorId ?? forwarded}`,
      240,
      60,
    );
    context.header("x-ratelimit-remaining", String(decision.remaining));
    if (!decision.allowed) {
      context.header("retry-after", String(decision.retryAfterSeconds));
      return context.json(
        failure(context, "RATE_LIMITED", "Request rate limit exceeded"),
        429,
      );
    }
    await next();
    return undefined;
  };
}
