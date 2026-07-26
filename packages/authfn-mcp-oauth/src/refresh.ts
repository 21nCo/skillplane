import { consumeRateLimit } from "@skillplane/db";
import { writeOAuthAudit, oauthRequestId } from "./audit.js";
import { isOAuthScope, type OAuthRuntime } from "./config.js";
import { OAuthError } from "./errors.js";
import { issueTokenPair, keyedHash, type TokenResponse } from "./tokens.js";

interface RefreshTokenRow {
  readonly id: string;
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
  readonly resource: string;
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

export async function exchangeRefreshToken(
  runtime: OAuthRuntime,
  input: RefreshTokenExchange,
): Promise<TokenResponse> {
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-refresh:${input.clientId}:${input.request.headers.get("cf-connecting-ip") ?? "unknown"}`,
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
  const database = await runtime.pool.connect();
  let response: TokenResponse | undefined;
  let committed = false;
  try {
    await database.query("BEGIN");
    const result = await database.query<RefreshTokenRow>(
      `SELECT id, family_id, user_id, client_id, resource, scopes, expires_at,
              consumed_at, revoked_at
         FROM authfn_oauth_refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [keyedHash(input.refreshToken, runtime.tokenPepper)],
    );
    const token = result.rows[0];
    if (!token) {
      throw new OAuthError("invalid_grant", "The refresh token is invalid");
    }
    if (token.consumed_at) {
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
        requestId: oauthRequestId(input.request),
        metadata: { familyId: token.family_id, resource: token.resource },
      });
      await database.query("COMMIT");
      committed = true;
    } else {
      if (
        token.revoked_at ||
        token.expires_at.getTime() <= runtime.now().getTime() ||
        token.client_id !== input.clientId ||
        token.resource !== input.resource
      ) {
        throw new OAuthError("invalid_grant", "The refresh token is invalid");
      }
      const scopes = reducedScopes(input.scope, token.scopes);
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
        requestId: oauthRequestId(input.request),
        metadata: {
          familyId: token.family_id,
          resource: token.resource,
          scopes,
        },
      });
      await database.query("COMMIT");
      committed = true;
    }
  } finally {
    if (!committed) {
      await database.query("ROLLBACK").catch(() => undefined);
    }
    database.release();
  }
  if (response) return response;
  throw new OAuthError(
    "invalid_grant",
    "Refresh token reuse was detected and the token family was revoked",
  );
}
