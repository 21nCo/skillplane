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
    // The subject columns never change, so read them unlocked and share-lock
    // the user's consents for this client before any token row lock. A
    // concurrent revokeConsent holds those consents FOR UPDATE while it sweeps
    // token rows, so taking the locks in the same order avoids a deadlock. A
    // token whose consent is gone is still revoked.
    const subject = await database.query<{
      readonly user_id: string;
      readonly client_id: string;
    }>(
      `SELECT user_id, client_id
         FROM authfn_oauth_refresh_tokens
        WHERE token_hash = $1
       UNION ALL
       SELECT user_id, client_id
         FROM authfn_oauth_access_tokens
        WHERE token_hash = $1
       LIMIT 1`,
      [hash],
    );
    const owner = subject.rows[0];
    if (owner?.client_id === input.clientId) {
      await lockClientConsents(database, owner.user_id, owner.client_id, "SHARE");
    }
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

/**
 * Locks every consent the user holds for one client, ordered by ID, so the
 * consent revoke (UPDATE) and the RFC 7009 token revoke (SHARE) acquire the
 * same rows in the same order before either touches a code or token row.
 */
async function lockClientConsents(
  database: PoolClient,
  userId: string,
  clientId: string,
  mode: "SHARE" | "UPDATE",
): Promise<ConsentRow[]> {
  const result = await database.query<ConsentRow>(
    `SELECT id, client_id, resource, revoked_at
       FROM authfn_oauth_consents
      WHERE user_id = $1 AND client_id = $2
      ORDER BY id
      FOR ${mode === "UPDATE" ? "UPDATE" : "SHARE"}`,
    [userId, clientId],
  );
  return result.rows;
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
    // A consent's client never changes, so read it unlocked, then lock every
    // consent of this user and client in one ordered statement. Concurrent
    // revocations, RFC 7009 revocation and token issuance (see
    // lockConsentForIssuance) serialize on the consent rows before any code or
    // token row is locked.
    const target = await database.query<{ readonly client_id: string }>(
      `SELECT client_id
         FROM authfn_oauth_consents
        WHERE id = $1 AND user_id = $2`,
      [input.consentId, input.userId],
    );
    const clientId = target.rows[0]?.client_id;
    const locked = clientId
      ? await lockClientConsents(database, input.userId, clientId, "UPDATE")
      : [];
    const consent = locked.find((row) => row.id === input.consentId);
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
    // Refresh tokens have no user index and are never pruned, so reach them
    // through their families. issueTokenPair writes every refresh token with
    // an access token of the same family, user and client, and access tokens
    // are never deleted, so the user-indexed access rows name every family.
    // The family index then bounds the sweep to this user's rows.
    const refreshTokens = await database.query(
      `UPDATE authfn_oauth_refresh_tokens
          SET revoked_at = $3
        WHERE family_id IN (
                SELECT family_id
                  FROM authfn_oauth_access_tokens
                 WHERE user_id = $1 AND client_id = $2
              )
          AND user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
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
