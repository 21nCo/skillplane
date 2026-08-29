import {
  createAuthFnRouteMeta,
  type AuthFnPlugin,
  type AuthFnPluginRuntimeContext,
} from "@authfn/core";
import {
  createMcpAuthorizationCompatibilityHandler,
  McpFnHostedAuthorizationError,
  type McpFnAuthorizationCompatibilityOptions,
  type McpFnValidatedAuthorizationRequest,
} from "@mcpfn/auth";
import { consumeRateLimit } from "@skillplane/db";
import { beginAuthorization, consentDetails, decideConsent } from "./authorization.js";
import {
  isClientMetadataDocumentUrlAllowed,
  registerClient,
  resolveRegisteredClient,
} from "./clients.js";
import {
  normalizeOAuthConfig,
  OAUTH_SCOPES,
  type AuthFnMcpOAuthConfig,
  type OAuthRuntime,
} from "./config.js";
import { exchangeAuthorizationCode } from "./codes.js";
import {
  authorizationErrorRedirect,
  OAuthError,
  oauthErrorResponse,
} from "./errors.js";
import { exchangeRefreshToken } from "./refresh.js";
import { revokeToken } from "./revocation.js";
import { createOAuthSchema } from "./schema.js";

async function tokenRateLimit(
  runtime: OAuthRuntime,
  clientId: string,
  request: Request,
): Promise<void> {
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-token:${clientId}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    60,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    throw new McpFnHostedAuthorizationError(
      "temporarily_unavailable",
      "Token requests are temporarily rate limited",
      {
        status: 429,
        details: { retryAfterSeconds: rate.retryAfterSeconds },
      },
    );
  }
}

async function clientResolutionRateLimit(
  runtime: OAuthRuntime,
  endpoint: "authorization" | "token" | "revocation",
  request: Request,
): Promise<void> {
  const network = request.headers.get("cf-connecting-ip") ?? "unknown";
  const prefix =
    endpoint === "authorization"
      ? "oauth-authorize"
      : endpoint === "token"
        ? "oauth-token-request"
        : "oauth-revoke-request";
  const rate = await consumeRateLimit(
    runtime.pool,
    `${prefix}:${network}`,
    60,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    throw new McpFnHostedAuthorizationError(
      "temporarily_unavailable",
      `${endpoint === "authorization" ? "Authorization" : "Token"} requests are temporarily rate limited`,
      {
        status: 429,
        details: { retryAfterSeconds: rate.retryAfterSeconds },
      },
    );
  }
}

async function fromTokenAuthority<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof OAuthError) {
      throw new McpFnHostedAuthorizationError(error.code, error.description, {
        status: error.status,
        ...(error.retryAfterSeconds === undefined
          ? {}
          : { details: { retryAfterSeconds: error.retryAfterSeconds } }),
      });
    }
    throw error;
  }
}

function safeAuthorizationResponse(
  runtime: OAuthRuntime,
  authfn: AuthFnPluginRuntimeContext,
  input: McpFnValidatedAuthorizationRequest,
  request: Request,
): Promise<Response> {
  return beginAuthorization(runtime, authfn, request, input).catch((error: unknown) => {
    if (error instanceof OAuthError) {
      return authorizationErrorRedirect(
        input.redirectUri,
        error.code,
        error.description,
        input.state,
      );
    }
    return oauthErrorResponse(error);
  });
}

function compatibilityOptions(
  runtime: OAuthRuntime,
  authorize: McpFnAuthorizationCompatibilityOptions["authorize"],
): McpFnAuthorizationCompatibilityOptions {
  return {
    issuer: runtime.issuer,
    endpointPrefix: "/auth/oauth",
    clients: {
      resolve: (clientId) => resolveRegisteredClient(runtime, clientId),
      register: (metadata, request) => registerClient(runtime, metadata, request),
    },
    beforeClientResolution: ({ endpoint, request }) =>
      clientResolutionRateLimit(runtime, endpoint, request),
    authorize,
    tokenAuthority: {
      exchangeAuthorizationCode: (input, request) =>
        fromTokenAuthority(async () => {
          await tokenRateLimit(runtime, input.client.clientId, request);
          const tokens = await exchangeAuthorizationCode(runtime, {
            code: input.code,
            clientId: input.client.clientId,
            redirectUri: input.redirectUri,
            resource: input.resource ?? runtime.resource,
            codeVerifier: input.codeVerifier,
          });
          return { ...tokens };
        }),
      refreshToken: (input, request) =>
        fromTokenAuthority(async () => {
          await tokenRateLimit(runtime, input.client.clientId, request);
          const tokens = await exchangeRefreshToken(runtime, {
            refreshToken: input.refreshToken,
            clientId: input.client.clientId,
            ...(input.resource ? { resource: input.resource } : {}),
            ...(input.scopes.length > 0 ? { scope: input.scopes.join(" ") } : {}),
            request,
          });
          return { ...tokens };
        }),
      revokeToken: (input, request) =>
        fromTokenAuthority(() =>
          revokeToken(runtime, {
            token: input.token,
            clientId: input.client.clientId,
            request,
          }),
        ),
    },
    capabilities: {
      tokenEndpointAuthMethods: ["none"],
      requireState: true,
      requireResource: true,
      rotateRefreshTokens: true,
    },
    supportedScopes: [...OAUTH_SCOPES],
    allowedResources: [runtime.resource],
    clientMetadataDocuments: {
      enabled: true,
      allow: isClientMetadataDocumentUrlAllowed,
      fetch: runtime.fetcher,
      maxBytes: 65_536,
      timeoutMs: 5_000,
      maxRedirects: 3,
    },
    extraMetadata: {
      response_modes_supported: ["query"],
      revocation_endpoint_auth_methods_supported: ["none"],
    },
    diagnostics: async (event) => {
      await runtime.emit({
        type: `mcpfn.oauth.${event.phase}`,
        requestId: `oauth:${crypto.randomUUID()}`,
        outcome: event.outcome,
        ...(event.details?.clientId && typeof event.details.clientId === "string"
          ? { clientId: event.details.clientId }
          : {}),
        ...(event.code ? { metadata: { code: event.code } } : {}),
      });
    },
  };
}

export interface AuthFnMcpOAuthPlugin {
  readonly plugin: AuthFnPlugin;
  readonly runtime: OAuthRuntime;
}

export function createAuthFnMcpOAuthPlugin(
  config: AuthFnMcpOAuthConfig,
): AuthFnMcpOAuthPlugin {
  const runtime = normalizeOAuthConfig(config);
  const plugin: AuthFnPlugin = {
    name: "skillplaneMcpOAuth",
    schema: () => createOAuthSchema(),
    routes: (authfn) => {
      const compatibility = createMcpAuthorizationCompatibilityHandler(
        compatibilityOptions(runtime, (input, request) =>
          safeAuthorizationResponse(runtime, authfn, input, request),
        ),
      );
      return [
        {
          method: "GET",
          path: "/oauth/authorize",
          meta:
            createAuthFnRouteMeta(
              "oauthAuthorize",
              "Start an MCP OAuth authorization code grant",
              { mode: "none" },
            ) ?? {},
          handler: compatibility,
        },
        {
          method: "GET",
          path: "/oauth/consent",
          meta:
            createAuthFnRouteMeta(
              "oauthConsentDetails",
              "Read the current OAuth consent request",
              { mode: "cookie-session" },
            ) ?? {},
          handler: async (request) => {
            try {
              return await consentDetails(runtime, authfn, request);
            } catch (error) {
              return oauthErrorResponse(error);
            }
          },
        },
        {
          method: "POST",
          path: "/oauth/consent",
          meta:
            createAuthFnRouteMeta(
              "oauthConsentDecision",
              "Approve or deny an OAuth consent request",
              { mode: "cookie-session", csrf: true },
            ) ?? {},
          handler: async (request) => {
            try {
              const body = (await request.clone().json()) as {
                readonly approved?: unknown;
              };
              if (typeof body.approved !== "boolean") {
                throw new OAuthError("invalid_request", "approved must be a boolean");
              }
              return await decideConsent(runtime, authfn, request, body.approved);
            } catch (error) {
              return oauthErrorResponse(error);
            }
          },
        },
        {
          method: "POST",
          path: "/oauth/token",
          meta:
            createAuthFnRouteMeta(
              "oauthToken",
              "Exchange an authorization code or refresh token",
              { mode: "none" },
            ) ?? {},
          handler: compatibility,
        },
        {
          method: "POST",
          path: "/oauth/revoke",
          meta:
            createAuthFnRouteMeta("oauthRevoke", "Revoke an OAuth token", {
              mode: "none",
            }) ?? {},
          handler: compatibility,
        },
        {
          method: "POST",
          path: "/oauth/register",
          meta:
            createAuthFnRouteMeta(
              "oauthRegister",
              "Dynamically register an MCP OAuth client",
              { mode: "none" },
            ) ?? {},
          handler: compatibility,
        },
      ];
    },
  };
  return { plugin, runtime };
}
