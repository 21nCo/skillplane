import {
  authorizationServerMetadata,
  metadataResponse,
  protectedResourceMetadata,
} from "@skillplane/auth";
import type { Context, Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { failure } from "../envelopes.js";

function unavailable(context: Context<ApiEnvironment>): Response {
  return context.json(
    failure(context, "SERVICE_UNAVAILABLE", "OAuth discovery is unavailable"),
    503,
    { "cache-control": "no-store" },
  );
}

export interface OAuthMetadataFallback {
  readonly issuer: string;
  readonly resource: string;
}

export function registerOAuthMetadataRoutes(
  app: Hono<ApiEnvironment>,
  fallback?: OAuthMetadataFallback,
): void {
  app.get("/.well-known/oauth-authorization-server", (context) => {
    const services = context.get("services");
    const runtime = services?.auth.oauth ?? fallback;
    return runtime
      ? metadataResponse(authorizationServerMetadata(runtime))
      : unavailable(context);
  });

  const protectedResource = (context: Context<ApiEnvironment>) => {
    const services = context.get("services");
    const runtime = services?.auth.oauth ?? fallback;
    return runtime
      ? metadataResponse(protectedResourceMetadata(runtime))
      : unavailable(context);
  };
  app.get("/.well-known/oauth-protected-resource", protectedResource);
  app.get("/.well-known/oauth-protected-resource/mcp", protectedResource);
}
