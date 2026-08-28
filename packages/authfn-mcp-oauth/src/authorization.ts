import {
  assertValidCsrf,
  getCookieSessionState,
  requireCookieSession,
} from "@authfn/core";
import type { AuthFnPluginRuntimeContext } from "@authfn/core";
import type { McpFnValidatedAuthorizationRequest } from "@mcpfn/auth";
import { consumeRateLimit } from "@skillplane/db";
import type { PoolClient } from "pg";
import { writeOAuthAudit, oauthRequestId } from "./audit.js";
import type { OAuthRuntime, OAuthScope } from "./config.js";
import { OAuthError, noStoreHeaders } from "./errors.js";
import { issueAuthorizationCode } from "./codes.js";
import { id, keyedHash, signPayload, verifySignedPayload } from "./tokens.js";

export interface ValidatedAuthorizationRequest {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly redirectHost: string;
  readonly loopbackRedirect: boolean;
  readonly resource: string;
  readonly scopes: readonly OAuthScope[];
  readonly state?: string;
  readonly codeChallenge: string;
}

interface RequestTokenPayload {
  readonly id: string;
  readonly expiresAt: number;
}

interface StoredAuthorizationRequest {
  readonly id: string;
  readonly request_hash: string;
  readonly payload: ValidatedAuthorizationRequest;
  readonly user_id: string | null;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

function storedAuthorizationRequest(
  input: McpFnValidatedAuthorizationRequest,
): ValidatedAuthorizationRequest {
  if (!input.resource) {
    throw new OAuthError("invalid_target", "The requested resource is required");
  }
  const parsedRedirect = new URL(input.redirectUri);
  const clientName =
    typeof input.client.metadata.client_name === "string"
      ? input.client.metadata.client_name
      : input.client.clientId;
  return {
    clientId: input.client.clientId,
    clientName,
    redirectUri: input.redirectUri,
    redirectHost: parsedRedirect.host,
    loopbackRedirect:
      parsedRedirect.protocol === "http:" &&
      ["localhost", "127.0.0.1", "::1"].includes(parsedRedirect.hostname),
    resource: input.resource,
    scopes: input.scopes as OAuthScope[],
    ...(input.state !== undefined ? { state: input.state } : {}),
    codeChallenge: input.codeChallenge,
  };
}

export async function preserveAuthorizationRequest(
  runtime: OAuthRuntime,
  request: ValidatedAuthorizationRequest,
  userId?: string,
): Promise<string> {
  const createdAt = runtime.now();
  const requestId = id("oar_", runtime.randomBytes);
  const payload: RequestTokenPayload = {
    id: requestId,
    expiresAt: createdAt.getTime() + runtime.authorizationRequestTtlSeconds * 1_000,
  };
  const token = signPayload(JSON.stringify(payload), runtime.tokenPepper);
  await runtime.pool.query(
    `INSERT INTO authfn_oauth_authorization_requests
       (id, request_hash, payload, user_id, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      requestId,
      keyedHash(token, runtime.tokenPepper),
      request,
      userId ?? null,
      new Date(payload.expiresAt),
      createdAt,
    ],
  );
  return token;
}

function decodeRequestToken(runtime: OAuthRuntime, token: string): RequestTokenPayload {
  const raw = verifySignedPayload(token, runtime.tokenPepper);
  if (!raw)
    throw new OAuthError("invalid_request", "The authorization request is invalid");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new OAuthError("invalid_request", "The authorization request is invalid");
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as RequestTokenPayload).id !== "string" ||
    typeof (value as RequestTokenPayload).expiresAt !== "number"
  ) {
    throw new OAuthError("invalid_request", "The authorization request is invalid");
  }
  return value as RequestTokenPayload;
}

async function loadStoredRequest(
  runtime: OAuthRuntime,
  token: string,
  userId: string,
  client?: PoolClient,
  lock = false,
): Promise<StoredAuthorizationRequest> {
  const tokenPayload = decodeRequestToken(runtime, token);
  const database = client ?? runtime.pool;
  const result = await database.query<StoredAuthorizationRequest>(
    `SELECT id, request_hash, payload, user_id, expires_at, consumed_at
       FROM authfn_oauth_authorization_requests
      WHERE id = $1 AND request_hash = $2
      ${lock ? "FOR UPDATE" : ""}`,
    [tokenPayload.id, keyedHash(token, runtime.tokenPepper)],
  );
  const stored = result.rows[0];
  if (
    !stored ||
    stored.consumed_at ||
    stored.expires_at.getTime() <= runtime.now().getTime() ||
    tokenPayload.expiresAt !== stored.expires_at.getTime() ||
    (stored.user_id !== null && stored.user_id !== userId)
  ) {
    throw new OAuthError(
      "invalid_request",
      "The authorization request expired or was already used",
    );
  }
  if (stored.user_id === null) {
    await database.query(
      `UPDATE authfn_oauth_authorization_requests
          SET user_id = $2
        WHERE id = $1 AND user_id IS NULL`,
      [stored.id, userId],
    );
  }
  return stored;
}

export async function beginAuthorization(
  runtime: OAuthRuntime,
  authfn: AuthFnPluginRuntimeContext,
  request: Request,
  input: McpFnValidatedAuthorizationRequest,
): Promise<Response> {
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-authorize:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    60,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    throw new OAuthError(
      "temporarily_unavailable",
      "Authorization requests are temporarily rate limited",
      429,
      rate.retryAfterSeconds,
    );
  }
  const state = await getCookieSessionState(authfn.config, request);
  const validated = storedAuthorizationRequest(input);
  const token = await preserveAuthorizationRequest(runtime, validated, state.user?.id);
  const consentPath = `/oauth/consent?request=${encodeURIComponent(token)}`;
  if (!state.user) {
    return Response.redirect(
      new URL(`/sign-in?next=${encodeURIComponent(consentPath)}`, runtime.issuer),
      302,
    );
  }
  return Response.redirect(new URL(consentPath, runtime.issuer), 302);
}

export async function consentDetails(
  runtime: OAuthRuntime,
  authfn: AuthFnPluginRuntimeContext,
  request: Request,
): Promise<Response> {
  const session = await requireCookieSession(authfn.config, request);
  const token = new URL(request.url).searchParams.get("request");
  if (!token) throw new OAuthError("invalid_request", "request is required");
  const stored = await loadStoredRequest(runtime, token, session.user.id);
  const headers = noStoreHeaders({ "content-type": "application/json" });
  return new Response(
    JSON.stringify({
      client: {
        id: stored.payload.clientId,
        name: stored.payload.clientName,
      },
      resource: stored.payload.resource,
      scopes: stored.payload.scopes,
      redirect: {
        uri: stored.payload.redirectUri,
        host: stored.payload.redirectHost,
        loopback: stored.payload.loopbackRedirect,
      },
    }),
    { status: 200, headers },
  );
}

export async function decideConsent(
  runtime: OAuthRuntime,
  authfn: AuthFnPluginRuntimeContext,
  request: Request,
  approved: boolean,
): Promise<Response> {
  const session = await requireCookieSession(authfn.config, request);
  assertValidCsrf(request, session);
  const body = (await request.json()) as { readonly request?: unknown };
  if (typeof body.request !== "string") {
    throw new OAuthError("invalid_request", "request is required");
  }
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    const stored = await loadStoredRequest(
      runtime,
      body.request,
      session.user.id,
      database,
      true,
    );
    await database.query(
      `UPDATE authfn_oauth_authorization_requests
          SET consumed_at = $2, user_id = $3
        WHERE id = $1 AND consumed_at IS NULL`,
      [stored.id, runtime.now(), session.user.id],
    );
    let redirectTo: string;
    if (approved) {
      const code = await issueAuthorizationCode(
        database,
        runtime,
        session.user.id,
        stored.payload,
      );
      await database.query(
        `INSERT INTO authfn_oauth_consents
           (id, user_id, client_id, resource, scopes, granted_at, revoked_at)
         VALUES ($1, $2, $3, $4, $5, $6, NULL)
         ON CONFLICT (user_id, client_id, resource)
         DO UPDATE SET scopes = EXCLUDED.scopes, granted_at = EXCLUDED.granted_at,
                       revoked_at = NULL`,
        [
          id("ocn_", runtime.randomBytes),
          session.user.id,
          stored.payload.clientId,
          stored.payload.resource,
          JSON.stringify(stored.payload.scopes),
          runtime.now(),
        ],
      );
      const target = new URL(stored.payload.redirectUri);
      target.searchParams.set("code", code);
      if (stored.payload.state) target.searchParams.set("state", stored.payload.state);
      redirectTo = target.toString();
      await writeOAuthAudit(database, runtime, {
        eventType: "oauth.consent.granted",
        action: "oauth.consent",
        outcome: "success",
        userId: session.user.id,
        clientId: stored.payload.clientId,
        requestId: oauthRequestId(request),
        metadata: {
          resource: stored.payload.resource,
          scopes: stored.payload.scopes,
        },
      });
    } else {
      const target = new URL(stored.payload.redirectUri);
      target.searchParams.set("error", "access_denied");
      target.searchParams.set(
        "error_description",
        "The resource owner denied the request",
      );
      if (stored.payload.state) {
        target.searchParams.set("state", stored.payload.state);
      }
      redirectTo = target.toString();
      await writeOAuthAudit(database, runtime, {
        eventType: "oauth.consent.denied",
        action: "oauth.consent",
        outcome: "denied",
        userId: session.user.id,
        clientId: stored.payload.clientId,
        requestId: oauthRequestId(request),
        metadata: {
          resource: stored.payload.resource,
          scopes: stored.payload.scopes,
        },
      });
    }
    await database.query("COMMIT");
    return new Response(JSON.stringify({ redirectTo }), {
      status: 200,
      headers: noStoreHeaders({ "content-type": "application/json" }),
    });
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
}
