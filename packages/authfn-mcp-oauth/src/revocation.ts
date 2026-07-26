import { writeOAuthAudit, oauthRequestId } from "./audit.js";
import type { OAuthRuntime } from "./config.js";
import { keyedHash } from "./tokens.js";

interface TokenRow {
  readonly id: string;
  readonly family_id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly resource: string;
}

export async function revokeToken(
  runtime: OAuthRuntime,
  input: {
    readonly token: string;
    readonly clientId: string;
    readonly request: Request;
  },
): Promise<void> {
  const hash = keyedHash(input.token, runtime.tokenPepper);
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    const refresh = await database.query<TokenRow>(
      `SELECT id, family_id, user_id, client_id, resource
         FROM authfn_oauth_refresh_tokens
        WHERE token_hash = $1
        FOR UPDATE`,
      [hash],
    );
    const access =
      refresh.rows.length === 0
        ? await database.query<TokenRow>(
            `SELECT id, family_id, user_id, client_id, resource
               FROM authfn_oauth_access_tokens
              WHERE token_hash = $1
              FOR UPDATE`,
            [hash],
          )
        : null;
    const token = refresh.rows[0] ?? access?.rows[0];
    if (token?.client_id === input.clientId) {
      const revokedAt = runtime.now();
      if (refresh.rows[0]) {
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
      } else {
        await database.query(
          `UPDATE authfn_oauth_access_tokens
              SET revoked_at = COALESCE(revoked_at, $2)
            WHERE id = $1`,
          [token.id, revokedAt],
        );
      }
      await writeOAuthAudit(database, runtime, {
        eventType: "oauth.token.revoked",
        action: "oauth.token.revoke",
        outcome: "success",
        userId: token.user_id,
        clientId: token.client_id,
        requestId: oauthRequestId(input.request),
        metadata: {
          tokenType: refresh.rows[0] ? "refresh" : "access",
          resource: token.resource,
        },
      });
    }
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
}
