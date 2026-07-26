import type { PoolClient } from "pg";
import type { ValidatedAuthorizationRequest } from "./authorization.js";
import type { OAuthRuntime } from "./config.js";
import { OAuthError } from "./errors.js";
import { issueTokenPair, type TokenResponse } from "./tokens.js";
import {
  id,
  keyedHash,
  randomOpaqueSecret,
  sha256Base64Url,
  secureEqual,
} from "./tokens.js";

interface AuthorizationCodeRow {
  readonly id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly resource: string;
  readonly scopes: string[];
  readonly code_challenge: string;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

export async function issueAuthorizationCode(
  client: PoolClient,
  runtime: OAuthRuntime,
  userId: string,
  request: ValidatedAuthorizationRequest,
): Promise<string> {
  const code = randomOpaqueSecret("spc_", runtime.randomBytes);
  const createdAt = runtime.now();
  await client.query(
    `INSERT INTO authfn_oauth_authorization_codes
       (id, code_hash, user_id, client_id, redirect_uri, resource, scopes,
        code_challenge, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      id("oac_", runtime.randomBytes),
      keyedHash(code, runtime.tokenPepper),
      userId,
      request.clientId,
      request.redirectUri,
      request.resource,
      JSON.stringify(request.scopes),
      request.codeChallenge,
      new Date(createdAt.getTime() + runtime.authorizationCodeTtlSeconds * 1_000),
      createdAt,
    ],
  );
  return code;
}

export interface AuthorizationCodeExchange {
  readonly code: string;
  readonly clientId: string;
  readonly redirectUri: string;
  readonly resource: string;
  readonly codeVerifier: string;
}

export async function exchangeAuthorizationCode(
  runtime: OAuthRuntime,
  input: AuthorizationCodeExchange,
): Promise<TokenResponse> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(input.codeVerifier)) {
    throw new OAuthError("invalid_grant", "The PKCE code verifier is invalid");
  }
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    const result = await database.query<AuthorizationCodeRow>(
      `SELECT id, user_id, client_id, redirect_uri, resource, scopes,
              code_challenge, expires_at, consumed_at
         FROM authfn_oauth_authorization_codes
        WHERE code_hash = $1
        FOR UPDATE`,
      [keyedHash(input.code, runtime.tokenPepper)],
    );
    const code = result.rows[0];
    const verifierChallenge = sha256Base64Url(input.codeVerifier);
    if (
      !code ||
      code.consumed_at ||
      code.expires_at.getTime() <= runtime.now().getTime() ||
      code.client_id !== input.clientId ||
      code.redirect_uri !== input.redirectUri ||
      code.resource !== input.resource ||
      !secureEqual(code.code_challenge, verifierChallenge)
    ) {
      throw new OAuthError("invalid_grant", "The authorization code is invalid");
    }
    await database.query(
      `UPDATE authfn_oauth_authorization_codes
          SET consumed_at = $2
        WHERE id = $1 AND consumed_at IS NULL`,
      [code.id, runtime.now()],
    );
    const tokens = await issueTokenPair(database, runtime, {
      userId: code.user_id,
      clientId: code.client_id,
      resource: code.resource,
      scopes: code.scopes,
    });
    await database.query("COMMIT");
    return tokens;
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
}
