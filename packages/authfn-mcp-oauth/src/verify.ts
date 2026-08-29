import type { OAuthRuntime } from "./config.js";
import { OAuthError } from "./errors.js";
import { keyedHash } from "./tokens.js";

interface AccessTokenRow {
  readonly id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly resource: string;
  readonly scopes: string[];
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

export interface VerifiedOAuthPrincipal {
  readonly kind: "oauth-user";
  readonly actorType: "user";
  readonly actorId: string;
  readonly userId: string;
  readonly clientId: string;
  readonly tokenId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date;
}

export async function verifyAccessToken(
  runtime: OAuthRuntime,
  token: string,
  options: {
    readonly resource: string;
    readonly requiredScopes?: readonly string[];
  },
): Promise<VerifiedOAuthPrincipal> {
  if (!token.startsWith("spo_") || token.length > 512) {
    throw new OAuthError("invalid_grant", "The access token is invalid", 401);
  }
  const result = await runtime.pool.query<AccessTokenRow>(
    `SELECT t.id, t.user_id, t.client_id, t.resource, t.scopes, t.expires_at,
            t.revoked_at
       FROM authfn_oauth_access_tokens t
       JOIN authfn_users u ON u.id = t.user_id
      WHERE t.token_hash = $1
      LIMIT 1`,
    [keyedHash(token, runtime.tokenPepper)],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.revoked_at ||
    row.expires_at.getTime() <= runtime.now().getTime() ||
    row.resource !== options.resource ||
    options.requiredScopes?.some((scope) => !row.scopes.includes(scope))
  ) {
    throw new OAuthError("invalid_grant", "The access token is invalid", 401);
  }
  return {
    kind: "oauth-user",
    actorType: "user",
    actorId: row.user_id,
    userId: row.user_id,
    clientId: row.client_id,
    tokenId: row.id,
    resource: row.resource,
    scopes: row.scopes,
    expiresAt: row.expires_at,
  };
}
