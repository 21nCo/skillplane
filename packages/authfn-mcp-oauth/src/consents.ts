import type { PoolClient } from "pg";
import type { OAuthRuntime } from "./config.js";

/** Consent identifiers are `ocn_` plus 18 random bytes in base64url. */
const CONSENT_ID = /^ocn_[A-Za-z0-9_-]{1,64}$/u;

export function isConsentId(value: string): boolean {
  return CONSENT_ID.test(value);
}

export interface OAuthConnection {
  readonly consentId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly grantedAt: Date;
  /**
   * When this user's newest token for the client and resource was issued,
   * which is the last code exchange or refresh. Skillplane does not record
   * each MCP request that presents an access token.
   */
  readonly lastTokenIssuedAt: Date | null;
}

interface ConnectionRow {
  readonly id: string;
  readonly client_id: string;
  readonly client_name: string | null;
  readonly resource: string;
  readonly scopes: unknown;
  readonly granted_at: Date;
  readonly last_token_issued_at: Date | null;
}

function scopeList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((scope): scope is string => typeof scope === "string")
    : [];
}

/** Lists the user's own active consents. Revoked consents are not returned. */
export async function listConsents(
  runtime: OAuthRuntime,
  userId: string,
): Promise<OAuthConnection[]> {
  const result = await runtime.pool.query<ConnectionRow>(
    `SELECT c.id, c.client_id, cl.client_name, c.resource, c.scopes, c.granted_at,
            (SELECT max(t.created_at)
               FROM authfn_oauth_access_tokens t
              WHERE t.user_id = c.user_id
                AND t.client_id = c.client_id
                AND t.resource = c.resource) AS last_token_issued_at
       FROM authfn_oauth_consents c
       LEFT JOIN authfn_oauth_clients cl ON cl.client_id = c.client_id
      WHERE c.user_id = $1 AND c.revoked_at IS NULL
      ORDER BY c.granted_at DESC, c.id`,
    [userId],
  );
  return result.rows.map((row) => ({
    consentId: row.id,
    clientId: row.client_id,
    clientName: row.client_name ?? row.client_id,
    resource: row.resource,
    scopes: scopeList(row.scopes),
    grantedAt: row.granted_at,
    lastTokenIssuedAt: row.last_token_issued_at,
  }));
}

/**
 * Token issuance takes a share lock on the consent before it locks the code or
 * refresh token it is exchanging, and refuses a missing or revoked consent.
 * `revokeConsent` takes the update lock in the same order, so an exchange that
 * is already in flight commits before the revocation sweeps its tokens, and an
 * exchange that starts later sees the revocation.
 */
export async function lockConsentForIssuance(
  database: PoolClient,
  subject: {
    readonly userId: string;
    readonly clientId: string;
    readonly resource: string;
  },
): Promise<boolean> {
  const result = await database.query<{ revoked_at: Date | null }>(
    `SELECT revoked_at
       FROM authfn_oauth_consents
      WHERE user_id = $1 AND client_id = $2 AND resource = $3
      FOR SHARE`,
    [subject.userId, subject.clientId, subject.resource],
  );
  // A missing consent reads as undefined, which is not an active consent.
  return result.rows[0]?.revoked_at === null;
}
