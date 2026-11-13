import { writeOAuthAudit, oauthRequestId } from "./audit.js";
import type { PoolClient } from "pg";
import type { OAuthRuntime } from "./config.js";
import { isConsentId } from "./consents.js";
import { keyedHash } from "./tokens.js";

interface TokenRow {
  readonly id: string;
  readonly family_id: string;
  readonly user_id: string;
  readonly client_id: string;
  readonly resource: string;
}

/** Revokes every access and refresh token in one token family. */
export async function revokeTokenFamily(
  database: PoolClient,
  familyId: string,
  revokedAt: Date,
): Promise<void> {
  await database.query(
    `UPDATE authfn_oauth_refresh_tokens
        SET revoked_at = COALESCE(revoked_at, $2)
      WHERE family_id = $1`,
    [familyId, revokedAt],
  );
  await database.query(
    `UPDATE authfn_oauth_access_tokens
        SET revoked_at = COALESCE(revoked_at, $2)
      WHERE family_id = $1`,
    [familyId, revokedAt],
  );
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
        await revokeTokenFamily(database, token.family_id, revokedAt);
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

interface ConsentRow {
  readonly id: string;
  readonly client_id: string;
  readonly resource: string;
  readonly revoked_at: Date | null;
}

export type ConsentRevocationResult = "revoked" | "already_revoked" | "not_found";

/**
 * Revokes one of the user's own consents together with every outstanding
 * authorization code and every access and refresh token that user holds for the
 * consent's client, so a client that never calls `/oauth/revoke` is cut off.
 * Another user's consent is reported as `not_found` and left unchanged.
 */
export async function revokeConsent(
  runtime: OAuthRuntime,
  input: {
    readonly userId: string;
    readonly consentId: string;
    readonly requestId: string;
  },
): Promise<ConsentRevocationResult> {
  if (!isConsentId(input.consentId)) return "not_found";
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    // Lock every consent of this user and client in one ordered statement so
    // concurrent revocations and token issuance (see lockConsentForIssuance)
    // serialize on the consent rows before any code or token row is locked.
    const locked = await database.query<ConsentRow>(
      `SELECT id, client_id, resource, revoked_at
         FROM authfn_oauth_consents
        WHERE user_id = $1
          AND client_id = (
            SELECT client_id
              FROM authfn_oauth_consents
             WHERE id = $2 AND user_id = $1
          )
        ORDER BY id
        FOR UPDATE`,
      [input.userId, input.consentId],
    );
    const consent = locked.rows.find((row) => row.id === input.consentId);
    if (!consent) {
      await database.query("ROLLBACK");
      return "not_found";
    }
    if (consent.revoked_at) {
      // Issuance refuses a revoked consent, so the earlier revocation already
      // ended every token and code; a repeat is not a second state change.
      await database.query("ROLLBACK");
      return "already_revoked";
    }
    const revokedAt = runtime.now();
    await database.query(
      `UPDATE authfn_oauth_consents
          SET revoked_at = $2
        WHERE id = $1`,
      [consent.id, revokedAt],
    );
    const subject = [input.userId, consent.client_id, revokedAt];
    // Unexpired codes only: an expired code can no longer be exchanged, and
    // the bound lets Postgres use the code expiry index.
    const codes = await database.query(
      `UPDATE authfn_oauth_authorization_codes
          SET consumed_at = $3
        WHERE user_id = $1 AND client_id = $2
          AND consumed_at IS NULL AND expires_at > $3`,
      subject,
    );
    const refreshTokens = await database.query(
      `UPDATE authfn_oauth_refresh_tokens
          SET revoked_at = $3
        WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      subject,
    );
    const accessTokens = await database.query(
      `UPDATE authfn_oauth_access_tokens
          SET revoked_at = $3
        WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      subject,
    );
    await writeOAuthAudit(database, runtime, {
      eventType: "oauth.consent.revoked",
      action: "oauth.consent.revoke",
      outcome: "success",
      userId: input.userId,
      clientId: consent.client_id,
      requestId: input.requestId,
      metadata: {
        consentId: consent.id,
        clientId: consent.client_id,
        resource: consent.resource,
        // Audit redaction drops keys containing "token" or "authorization", so
        // counts use plain grant names; no code or token value is recorded.
        revokedGrants: {
          codes: codes.rowCount ?? 0,
          access: accessTokens.rowCount ?? 0,
          refresh: refreshTokens.rowCount ?? 0,
        },
      },
    });
    await database.query("COMMIT");
    return "revoked";
  } catch (error) {
    await database.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    database.release();
  }
}
