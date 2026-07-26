import type { MiddlewareHandler } from "hono";
import type { ApiEnvironment } from "../context.js";

export function requestIdMiddleware(
  createRequestId: () => string,
): MiddlewareHandler<ApiEnvironment> {
  return async (context, next) => {
    const incoming = context.req.header("x-request-id");
    const requestId =
      incoming && /^[A-Za-z0-9._:-]{1,128}$/.test(incoming)
        ? incoming
        : createRequestId();
    context.set("requestId", requestId);
    context.header("x-request-id", requestId);
    await next();
  };
}
