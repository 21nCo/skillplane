import { consumeRateLimit } from "@skillplane/db";
import { writeOAuthAudit, oauthRequestId } from "./audit.js";
import { isOAuthScope, type OAuthRuntime } from "./config.js";
import { OAuthError } from "./errors.js";
import { issueTokenPair, keyedHash, type TokenResponse } from "./tokens.js";

interface RefreshTokenRow {
  readonly id: string;
  readonly parent_id: string | null;
  readonly family_id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly resource: string;
  readonly scopes: string[];
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
  readonly revoked_at: Date | null;
}

export interface RefreshTokenExchange {
  readonly refreshToken: string;
  readonly clientId: string;
  readonly resource?: string;
  readonly scope?: string;
  readonly request: Request;
}

function reducedScopes(
  requested: string | undefined,
  granted: readonly string[],
): string[] {
  if (requested === undefined) return [...granted];
  const scopes = [...new Set(requested.split(" ").filter(Boolean))];
  if (
    scopes.length < 1 ||
    scopes.length > 20 ||
    scopes.some((scope) => !isOAuthScope(scope) || !granted.includes(scope))
  ) {
    throw new OAuthError(
      "invalid_scope",
      "Refresh scopes must be a subset of the grant",
    );
  }
  return scopes;
}

async function performRefresh(
  runtime: OAuthRuntime,
  input: RefreshTokenExchange,
  diagnostic: RefreshDiagnostic,
): Promise<TokenResponse> {
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-refresh:${input.clientId}:${input.request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    60,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    diagnostic.reason = "rate_limited";
    throw new OAuthError(
      "temporarily_unavailable",
      "Token requests are temporarily rate limited",
      429,
      rate.retryAfterSeconds,
    );
  }
  const database = await runtime.pool.connect();
  let response: TokenResponse | undefined;
  let committed = false;
  try {
    await database.query("BEGIN");
    const result = await database.query<RefreshTokenRow>(
      `SELECT id, parent_id, family_id, user_id, client_id, resource, scopes, expires_at,
              consumed_at, revoked_at
         FROM authfn_oauth_refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [keyedHash(input.refreshToken, runtime.tokenPepper)],
    );
    const token = result.rows[0];
    if (!token) {
      diagnostic.reason = "unknown_grant";
      throw new OAuthError("invalid_grant", "The refresh token is invalid");
    }
    diagnostic.clientId = token.client_id;
    Object.assign(diagnostic.metadata, {
      familyId: token.family_id,
      grantId: token.id,
      parentGrantId: token.parent_id,
      expiresAt: token.expires_at.toISOString(),
      consumedAt: token.consumed_at?.toISOString() ?? null,
      revokedAt: token.revoked_at?.toISOString() ?? null,
    });
    if (token.consumed_at) {
      diagnostic.reason = "reuse_detected";
      const revokedAt = runtime.now();
      await database.query(
        `UPDATE authfn_oauth_refresh_tokens
            SET revoked_at = COALESCE(revoked_at, $2)
          WHERE family_id = $1`,
        [token.family_id, revokedAt],
      );
      await database.query(
        `UPDATE authfn_oauth_access_tokens
            SET revoked_at = COALESCE(revoked_at, $2)
          WHERE family_id = $1`,
        [token.family_id, revokedAt],
      );
      await writeOAuthAudit(database, runtime, {
        eventType: "oauth.refresh.reuse_detected",
        action: "oauth.token.refresh",
        outcome: "error",
        userId: token.user_id,
        clientId: token.client_id,
        requestId: diagnostic.requestId,
        metadata: { familyId: token.family_id, resource: token.resource },
      });
      await database.query("COMMIT");
      committed = true;
      diagnostic.committed = true;
    } else {
      const rejection = token.revoked_at
        ? "revoked_grant"
        : token.expires_at.getTime() <= runtime.now().getTime()
          ? "expired_grant"
          : token.client_id !== input.clientId
            ? "client_mismatch"
            : token.resource !== runtime.resource ||
                (input.resource !== undefined && token.resource !== input.resource)
              ? "resource_mismatch"
              : undefined;
      if (rejection) {
        diagnostic.reason = rejection;
        throw new OAuthError("invalid_grant", "The refresh token is invalid");
      }
      diagnostic.reason = "invalid_scope";
      const scopes = reducedScopes(input.scope, token.scopes);
      diagnostic.reason = "internal_error";
      await database.query(
        `UPDATE authfn_oauth_refresh_tokens
            SET consumed_at = $2
          WHERE id = $1 AND consumed_at IS NULL`,
        [token.id, runtime.now()],
      );
      response = await issueTokenPair(database, runtime, {
        userId: token.user_id,
        clientId: token.client_id,
        resource: token.resource,
        scopes,
        familyId: token.family_id,
        parentRefreshTokenId: token.id,
        refreshExpiresAt: token.expires_at,
      });
      await writeOAuthAudit(database, runtime, {
        eventType: "oauth.refresh.rotated",
        action: "oauth.token.refresh",
        outcome: "success",
        userId: token.user_id,
        clientId: token.client_id,
        requestId: diagnostic.requestId,
        metadata: {
          familyId: token.family_id,
          resource: token.resource,
          scopes,
        },
      });
      await database.query("COMMIT");
      committed = true;
      diagnostic.committed = true;
    }
  } finally {
    if (!committed) {
      await database.query("ROLLBACK").catch(() => undefined);
    }
    database.release();
  }
  if (response) {
    diagnostic.reason = "rotated";
    diagnostic.metadata.replacementFingerprint = diagnosticFingerprint(
      runtime,
      "grant",
      response.refresh_token,
    );
    return response;
  }
  throw new OAuthError(
    "invalid_grant",
    "Refresh token reuse was detected and the token family was revoked",
  );
}

interface RefreshDiagnostic {
  requestId: string;
  clientId?: string;
  reason: string;
  committed: boolean;
  metadata: Record<string, unknown>;
}

// Domain-separated HMACs are correlation identifiers, never credential hashes
// used for database lookup. Do not log raw credentials, headers, or error text.
function diagnosticFingerprint(
  runtime: OAuthRuntime,
  kind: string,
  value: string,
): string {
  return keyedHash(`oauth-diagnostic:${kind}:${value}`, runtime.tokenPepper).slice(
    0,
    32,
  );
}

export async function exchangeRefreshToken(
  runtime: OAuthRuntime,
  input: RefreshTokenExchange,
): Promise<TokenResponse> {
  const startedAt = Date.now();
  const diagnostic: RefreshDiagnostic = {
    requestId: oauthRequestId(input.request),
    reason: "internal_error",
    committed: false,
    metadata: {
      grantFingerprint: diagnosticFingerprint(runtime, "grant", input.refreshToken),
      presentedClientFingerprint: diagnosticFingerprint(
        runtime,
        "client",
        input.clientId,
      ),
    },
  };
  const ray = input.request.headers.get("cf-ray");
  if (ray && /^[a-f0-9]{16}(?:-[A-Z]{3})?$/i.test(ray)) diagnostic.metadata.cfRay = ray;
  for (const [header, key] of [
    ["user-agent", "agentFingerprint"],
    ["cf-connecting-ip", "networkFingerprint"],
  ] as const) {
    const value = input.request.headers.get(header);
    if (value) diagnostic.metadata[key] = diagnosticFingerprint(runtime, header, value);
  }
  const agent = input.request.headers.get("user-agent") ?? "";
  if (/^codex-mcp-client\/[0-9.]{1,32}$/.test(agent))
    diagnostic.metadata.clientSoftware = agent;
  let succeeded = false;
  try {
    const result = await performRefresh(runtime, input, diagnostic);
    succeeded = true;
    return result;
  } catch (error) {
    if (!(error instanceof OAuthError)) diagnostic.reason = "internal_error";
    throw error;
  } finally {
    // Emit outside the transaction: failed grants otherwise lose their evidence
    // on rollback. Success means committed issuance, not client receipt/storage.
    try {
      await runtime.emit({
        type: "oauth.refresh.completed",
        requestId: diagnostic.requestId,
        outcome: succeeded ? "success" : "error",
        ...(diagnostic.clientId ? { clientId: diagnostic.clientId } : {}),
        metadata: {
          ...diagnostic.metadata,
          reason: diagnostic.reason,
          transactionCommitted: diagnostic.committed,
          durationMs: Math.max(0, Date.now() - startedAt),
        },
      });
    } catch {
      // Observability must not turn committed issuance into a failed exchange.
    }
  }
}
