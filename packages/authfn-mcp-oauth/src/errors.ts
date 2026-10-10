import { AuthFnError } from "authfn";

export type OAuthErrorCode =
  | "invalid_request"
  | "invalid_client"
  | "invalid_grant"
  | "unauthorized_client"
  | "unsupported_response_type"
  | "unsupported_grant_type"
  | "invalid_scope"
  | "invalid_target"
  | "access_denied"
  | "server_error"
  | "temporarily_unavailable";

export class OAuthError extends Error {
  readonly code: OAuthErrorCode;
  readonly status: number;
  readonly description: string;
  readonly retryAfterSeconds: number | undefined;

  constructor(
    code: OAuthErrorCode,
    description: string,
    status = code === "invalid_client" ? 401 : 400,
    retryAfterSeconds?: number,
  ) {
    super(description);
    this.name = "OAuthError";
    this.code = code;
    this.status = status;
    this.description = description;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function noStoreHeaders(extra?: HeadersInit): Headers {
  const headers = new Headers(extra);
  headers.set("cache-control", "no-store");
  headers.set("pragma", "no-cache");
  headers.set("x-content-type-options", "nosniff");
  return headers;
}

export function oauthErrorResponse(error: unknown): Response {
  const mapped =
    error instanceof AuthFnError
      ? error.code === "AUTHFN_CSRF_INVALID"
        ? new OAuthError(
            "access_denied",
            "The consent request could not be verified",
            403,
          )
        : [
              "AUTHFN_UNAUTHENTICATED",
              "AUTHFN_SESSION_EXPIRED",
              "AUTHFN_SESSION_REVOKED",
            ].includes(error.code)
          ? new OAuthError("access_denied", "A current user session is required", 401)
          : error.code === "AUTHFN_RATE_LIMITED"
            ? new OAuthError(
                "temporarily_unavailable",
                "The authorization request is temporarily rate limited",
                429,
              )
            : new OAuthError("invalid_request", "The authorization request is invalid")
      : error;
  const safe =
    mapped instanceof OAuthError
      ? mapped
      : new OAuthError(
          "server_error",
          "The authorization server could not complete the request",
          500,
        );
  const headers = noStoreHeaders({ "content-type": "application/json" });
  if (safe.code === "invalid_client") {
    headers.set("www-authenticate", 'Bearer error="invalid_client"');
  }
  if (safe.retryAfterSeconds !== undefined) {
    headers.set("retry-after", String(safe.retryAfterSeconds));
  }
  return new Response(
    JSON.stringify({
      error: safe.code,
      error_description: safe.description,
    }),
    { status: safe.status, headers },
  );
}

export function authorizationErrorRedirect(
  redirectUri: string,
  code: OAuthErrorCode,
  description: string,
  state?: string,
): Response {
  const target = new URL(redirectUri);
  target.searchParams.set("error", code);
  target.searchParams.set("error_description", description);
  if (state) target.searchParams.set("state", state);
  return Response.redirect(target, 302);
}
