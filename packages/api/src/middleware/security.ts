import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { ApiEnvironment } from "../context.js";

export function securityMiddleware(): MiddlewareHandler<ApiEnvironment> {
  const applySecureHeaders = secureHeaders({
    contentSecurityPolicy: {
      defaultSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
    crossOriginResourcePolicy: "same-origin",
    referrerPolicy: "no-referrer",
    strictTransportSecurity: "max-age=63072000; includeSubDomains; preload",
    xContentTypeOptions: "nosniff",
    xFrameOptions: "DENY",
  });
  return async (context, next) => {
    await applySecureHeaders(context, next);
    if (!context.res.headers.has("cache-control")) {
      context.header("cache-control", "private, no-store");
    }
  };
}
