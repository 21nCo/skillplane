import type { MiddlewareHandler } from "hono";
import type { ApiEnvironment } from "../context.js";

export function observabilityMiddleware(): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const startedAt = performance.now();
    context.set("startedAt", startedAt);
    await next();
    const duration = Math.max(0, performance.now() - startedAt).toFixed(1);
    context.header("server-timing", `app;dur=${duration}`);
    if (!context.res.headers.has("cache-control")) {
      context.header("cache-control", "private, no-store");
    }
  };
}
