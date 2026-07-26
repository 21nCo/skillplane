import {
  createHash,
  createHmac,
  randomBytes as nodeRandomBytes,
  timingSafeEqual,
} from "node:crypto";
import type { PoolClient } from "pg";
import type { OAuthRuntime } from "./config.js";

export type RandomBytes = (size: number) => Uint8Array;

export function base64Url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

export function randomOpaqueSecret(
  prefix: "spc_" | "spo_" | "spr_" | "srr_",
  randomBytes: RandomBytes = nodeRandomBytes,
): string {
  return `${prefix}${base64Url(randomBytes(32))}`;
}

export function keyedHash(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

export function sha256Base64Url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function secureEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signPayload(payload: string, pepper: string): string {
  return `${base64Url(Buffer.from(payload, "utf8"))}.${createHmac("sha256", pepper)
    .update(payload)
    .digest("base64url")}`;
}

export function verifySignedPayload(token: string, pepper: string): string | null {
  const separator = token.lastIndexOf(".");
  if (separator < 1) return null;
  const encoded = token.slice(0, separator);
  const received = token.slice(separator + 1);
  let payload: string;
  try {
    payload = Buffer.from(encoded, "base64url").toString("utf8");
  } catch {
    return null;
  }
  const expected = createHmac("sha256", pepper).update(payload).digest("base64url");
  return secureEqual(received, expected) ? payload : null;
}

export function id(prefix: string, randomBytes: RandomBytes = nodeRandomBytes): string {
  return `${prefix}${base64Url(randomBytes(18))}`;
}

export interface TokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly refresh_token: string;
  readonly scope: string;
}

export interface TokenSubject {
  readonly userId: string;
  readonly clientId: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly familyId?: string;
  readonly parentRefreshTokenId?: string;
  readonly refreshExpiresAt?: Date;
}

export async function issueTokenPair(
  client: PoolClient,
  runtime: OAuthRuntime,
  subject: TokenSubject,
): Promise<TokenResponse> {
  const createdAt = runtime.now();
  const accessToken = randomOpaqueSecret("spo_", runtime.randomBytes);
  const refreshToken = randomOpaqueSecret("spr_", runtime.randomBytes);
  const familyId = subject.familyId ?? id("otf_", runtime.randomBytes);
  const accessTokenId = id("oat_", runtime.randomBytes);
  const refreshTokenId = id("ort_", runtime.randomBytes);
  const accessExpiresAt = new Date(
    createdAt.getTime() + runtime.accessTokenTtlSeconds * 1_000,
  );
  const refreshExpiresAt =
    subject.refreshExpiresAt ??
    new Date(createdAt.getTime() + runtime.refreshTokenTtlSeconds * 1_000);
  await client.query(
    `INSERT INTO authfn_oauth_access_tokens
       (id, token_hash, family_id, user_id, client_id, resource, scopes,
        expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      accessTokenId,
      keyedHash(accessToken, runtime.tokenPepper),
      familyId,
      subject.userId,
      subject.clientId,
      subject.resource,
      JSON.stringify(subject.scopes),
      accessExpiresAt,
      createdAt,
    ],
  );
  await client.query(
    `INSERT INTO authfn_oauth_refresh_tokens
       (id, token_hash, family_id, parent_id, user_id, client_id, resource,
        scopes, expires_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      refreshTokenId,
      keyedHash(refreshToken, runtime.tokenPepper),
      familyId,
      subject.parentRefreshTokenId ?? null,
      subject.userId,
      subject.clientId,
      subject.resource,
      JSON.stringify(subject.scopes),
      refreshExpiresAt,
      createdAt,
    ],
  );
  return {
    access_token: accessToken,
    token_type: "Bearer",
    expires_in: runtime.accessTokenTtlSeconds,
    refresh_token: refreshToken,
    scope: subject.scopes.join(" "),
  };
}
