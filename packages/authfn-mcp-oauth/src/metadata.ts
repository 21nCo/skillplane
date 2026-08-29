import {
  bearerChallengeResponse,
  createMcpAuthorizationServerMetadata,
  createProtectedResourceMetadata,
  protectedResourceMetadataUrl,
} from "@mcpfn/auth";
import { isOAuthScope, OAUTH_SCOPES, type OAuthRuntime } from "./config.js";
import { noStoreHeaders } from "./errors.js";

export function authorizationServerMetadata(
  runtime: Pick<OAuthRuntime, "issuer" | "resource">,
): ReturnType<typeof createMcpAuthorizationServerMetadata> {
  return createMcpAuthorizationServerMetadata({
    issuer: runtime.issuer,
    endpointPrefix: "/auth/oauth",
    dynamicRegistration: true,
    refreshTokenGrant: true,
    tokenRevocation: true,
    tokenEndpointAuthMethods: ["none"],
    supportedScopes: [...OAUTH_SCOPES],
    clientMetadataDocuments: true,
    extraMetadata: {
      response_modes_supported: ["query"],
      revocation_endpoint_auth_methods_supported: ["none"],
    },
  });
}

export function protectedResourceMetadata(
  runtime: Pick<OAuthRuntime, "issuer" | "resource">,
): ReturnType<typeof createProtectedResourceMetadata> {
  return createProtectedResourceMetadata({
    resource: runtime.resource,
    authorizationServers: [runtime.issuer],
    scopesSupported: [...OAUTH_SCOPES],
    resourceName: "Skillplane MCP",
  });
}

export function metadataResponse(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: noStoreHeaders({
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    }),
  });
}

export function protectedResourceChallenge(
  runtime: Pick<OAuthRuntime, "resource">,
  options: {
    readonly error?: "invalid_token" | "insufficient_scope";
    readonly scopes?: readonly string[];
  } = {},
): string {
  const scopes = options.scopes?.filter(isOAuthScope) ?? [];
  const response = bearerChallengeResponse(
    options.error === "insufficient_scope" ? 403 : 401,
    protectedResourceMetadataUrl(runtime.resource),
    {
      error: options.error ?? "invalid_token",
      description:
        options.error === "insufficient_scope"
          ? "The Bearer credential lacks required scopes"
          : "A valid Bearer access token is required",
      ...(scopes.length > 0 ? { scope: scopes.join(" ") } : {}),
    },
  );
  return response.headers.get("www-authenticate") ?? "Bearer";
}
