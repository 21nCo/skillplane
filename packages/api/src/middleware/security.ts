import type { MiddlewareHandler } from "hono";
import { secureHeaders } from "hono/secure-headers";
import type { ApiEnvironment } from "../context.js";

export function securityMiddleware(): MiddlewareHandler<ApiEnvironment> {
  return secureHeaders({
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
}
