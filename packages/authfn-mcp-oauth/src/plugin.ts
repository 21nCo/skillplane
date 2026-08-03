import {
  createAuthFnRouteMeta,
  type AuthFnPlugin,
  type AuthFnPluginRuntimeContext,
} from "@authfn/core";
import { consumeRateLimit } from "@skillplane/db";
import { authorize, consentDetails, decideConsent } from "./authorization.js";
import { getRegisteredClient, registerClient, resolveClient } from "./clients.js";
import {
  normalizeOAuthConfig,
  type AuthFnMcpOAuthConfig,
  type OAuthRuntime,
} from "./config.js";
import { exchangeAuthorizationCode } from "./codes.js";
import {
  authorizationErrorRedirect,
  noStoreHeaders,
  OAuthError,
  oauthErrorResponse,
} from "./errors.js";
import { exchangeRefreshToken } from "./refresh.js";
import { revokeToken } from "./revocation.js";
import { createOAuthSchema } from "./schema.js";

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: noStoreHeaders({ "content-type": "application/json" }),
  });
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (
    length > 32_768 ||
    !request.headers.get("content-type")?.startsWith("application/json")
  ) {
    throw new OAuthError(
      "invalid_request",
      "A small application/json body is required",
    );
  }
  try {
    const body: unknown = await request.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("not an object");
    }
    return body as Record<string, unknown>;
  } catch {
    throw new OAuthError("invalid_request", "The JSON request body is invalid");
  }
}

async function readForm(request: Request): Promise<URLSearchParams> {
  if (
    request.headers.get("authorization")?.startsWith("Basic ") ||
    !request.headers
      .get("content-type")
      ?.startsWith("application/x-www-form-urlencoded")
  ) {
    throw new OAuthError(
      "invalid_client",
      "Public clients must use an application/x-www-form-urlencoded body",
    );
  }
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > 16_384) {
    throw new OAuthError("invalid_request", "The form request is too large");
  }
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > 16_384) {
    throw new OAuthError("invalid_request", "The form request is too large");
  }
  return new URLSearchParams(text);
}

function formValue(
  form: URLSearchParams,
  name: string,
  required = true,
): string | undefined {
  const values = form.getAll(name);
  if (
    values.length > 1 ||
    (required && values.length !== 1) ||
    values.some((value) => value.length === 0)
  ) {
    throw new OAuthError("invalid_request", `${name} must be provided exactly once`);
  }
  return values[0];
}

function requiredFormValue(form: URLSearchParams, name: string): string {
  const value = formValue(form, name);
  if (value === undefined) {
    throw new OAuthError("invalid_request", `${name} is required`);
  }
  return value;
}

async function safeAuthorize(
  runtime: OAuthRuntime,
  authfn: AuthFnPluginRuntimeContext,
  request: Request,
): Promise<Response> {
  try {
    return await authorize(runtime, authfn, request);
  } catch (error) {
    if (!(error instanceof OAuthError)) return oauthErrorResponse(error);
    const url = new URL(request.url);
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    if (
      clientId &&
      redirectUri &&
      url.searchParams.getAll("redirect_uri").length === 1
    ) {
      try {
        const client = await resolveClient(runtime, clientId);
        if (client.redirectUris.includes(redirectUri)) {
          return authorizationErrorRedirect(
            redirectUri,
            error.code,
            error.description,
            url.searchParams.get("state") ?? undefined,
          );
        }
      } catch {
        // An untrusted redirect must never receive an OAuth error.
      }
    }
    return oauthErrorResponse(error);
  }
}

async function token(runtime: OAuthRuntime, request: Request): Promise<Response> {
  const form = await readForm(request);
  const grantType = requiredFormValue(form, "grant_type");
  const clientId = requiredFormValue(form, "client_id");
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-token:${clientId}:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    60,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    throw new OAuthError(
      "temporarily_unavailable",
      "Token requests are temporarily rate limited",
      429,
      rate.retryAfterSeconds,
    );
  }
  await resolveClient(runtime, clientId);
  if (grantType === "authorization_code") {
    const resource = requiredFormValue(form, "resource");
    if (resource !== runtime.resource) {
      throw new OAuthError("invalid_target", "The token resource is invalid");
    }
    return json(
      await exchangeAuthorizationCode(runtime, {
        code: requiredFormValue(form, "code"),
        clientId,
        redirectUri: requiredFormValue(form, "redirect_uri"),
        resource,
        codeVerifier: requiredFormValue(form, "code_verifier"),
      }),
    );
  }
  if (grantType === "refresh_token") {
    const resource = formValue(form, "resource", false);
    if (resource !== undefined && resource !== runtime.resource) {
      throw new OAuthError("invalid_target", "The token resource is invalid");
    }
    const scope = formValue(form, "scope", false);
    return json(
      await exchangeRefreshToken(runtime, {
        refreshToken: requiredFormValue(form, "refresh_token"),
        clientId,
        ...(resource !== undefined ? { resource } : {}),
        ...(scope !== undefined ? { scope } : {}),
        request,
      }),
    );
  }
  throw new OAuthError(
    "unsupported_grant_type",
    "Only authorization_code and refresh_token grants are supported",
  );
}

function publicClientResponse(
  client: Awaited<ReturnType<typeof registerClient>>,
): Record<string, unknown> {
  return {
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
    token_endpoint_auth_method: client.tokenEndpointAuthMethod,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    client_id_issued_at: client.clientIdIssuedAt,
    registration_access_token: client.registrationAccessToken,
    registration_client_uri: client.registrationClientUri,
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
    routes: (authfn) => [
      {
        method: "GET",
        path: "/oauth/authorize",
        meta:
          createAuthFnRouteMeta(
            "oauthAuthorize",
            "Start an OAuth authorization code grant",
            { mode: "none" },
          ) ?? {},
        handler: (request) => safeAuthorize(runtime, authfn, request),
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
        handler: async (request) => {
          try {
            return await token(runtime, request);
          } catch (error) {
            return oauthErrorResponse(error);
          }
        },
      },
      {
        method: "POST",
        path: "/oauth/revoke",
        meta:
          createAuthFnRouteMeta("oauthRevoke", "Revoke an OAuth token", {
            mode: "none",
          }) ?? {},
        handler: async (request) => {
          try {
            const form = await readForm(request);
            const clientId = requiredFormValue(form, "client_id");
            await resolveClient(runtime, clientId);
            await revokeToken(runtime, {
              token: requiredFormValue(form, "token"),
              clientId,
              request,
            });
            return new Response(null, { status: 200, headers: noStoreHeaders() });
          } catch (error) {
            return oauthErrorResponse(error);
          }
        },
      },
      {
        method: "POST",
        path: "/oauth/register",
        meta:
          createAuthFnRouteMeta(
            "oauthRegister",
            "Dynamically register a public OAuth client",
            { mode: "none" },
          ) ?? {},
        handler: async (request) => {
          try {
            const body = await readJson(request);
            const result = await registerClient(runtime, body, request);
            return json(publicClientResponse(result), 201);
          } catch (error) {
            return oauthErrorResponse(error);
          }
        },
      },
      {
        method: "GET",
        path: "/oauth/register/:clientId",
        meta:
          createAuthFnRouteMeta(
            "oauthReadRegistration",
            "Read dynamically registered OAuth client metadata",
            { mode: "none" },
          ) ?? {},
        handler: async (
          request,
          context: { readonly params: Readonly<Record<string, string>> },
        ) => {
          try {
            const clientId = decodeURIComponent(context.params.clientId ?? "");
            const client = await getRegisteredClient(
              runtime,
              clientId,
              request.headers.get("authorization"),
            );
            return json({
              client_id: client.clientId,
              client_name: client.clientName,
              redirect_uris: client.redirectUris,
              token_endpoint_auth_method: "none",
              grant_types: ["authorization_code", "refresh_token"],
              response_types: ["code"],
            });
          } catch (error) {
            return oauthErrorResponse(error);
          }
        },
      },
    ],
  };
  return { plugin, runtime };
}
