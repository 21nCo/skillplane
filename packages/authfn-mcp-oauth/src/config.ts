import type { Pool } from "pg";
import { randomBytes as nodeRandomBytes } from "node:crypto";
import type { RandomBytes } from "./tokens.js";

export const MCP_RESOURCE = "https://mcp.skillplane.dev/mcp";
export const PRODUCTION_ISSUER = "https://app.skillplane.dev";
export const OAUTH_SCOPES = [
  "skills:read",
  "skills:write",
  "skills:amend",
  "skills:publish",
  "contexts:read",
  "contexts:write",
  "audit:read",
] as const;
export type OAuthScope = (typeof OAUTH_SCOPES)[number];

export interface OAuthSecurityEvent {
  readonly type: string;
  readonly requestId: string;
  readonly outcome: string;
  readonly actorId?: string;
  readonly clientId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AuthFnMcpOAuthConfig {
  readonly pool: Pool;
  readonly issuer: string;
  readonly resource?: string;
  readonly tokenPepper: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly randomBytes?: RandomBytes;
  readonly emit?: (event: OAuthSecurityEvent) => Promise<void> | void;
  readonly authorizationRequestTtlSeconds?: number;
  readonly authorizationCodeTtlSeconds?: number;
  readonly accessTokenTtlSeconds?: number;
  readonly refreshTokenTtlSeconds?: number;
}

export interface OAuthRuntime {
  readonly pool: Pool;
  readonly issuer: string;
  readonly resource: string;
  readonly tokenPepper: string;
  readonly fetcher: typeof fetch;
  readonly now: () => Date;
  readonly randomBytes: RandomBytes;
  readonly emit: (event: OAuthSecurityEvent) => Promise<void>;
  readonly authorizationRequestTtlSeconds: number;
  readonly authorizationCodeTtlSeconds: number;
  readonly accessTokenTtlSeconds: number;
  readonly refreshTokenTtlSeconds: number;
}

function canonicalHttpsUrl(value: string, field: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  const localHttp =
    parsed.protocol === "http:" &&
    ["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== parsed.pathname.replace(/\/{2,}/g, "/")
  ) {
    throw new Error(
      `${field} must be a canonical HTTPS URL, or a loopback HTTP URL for local development`,
    );
  }
  return parsed.toString().replace(/\/$/, "");
}

export function normalizeOAuthConfig(config: AuthFnMcpOAuthConfig): OAuthRuntime {
  const issuer = canonicalHttpsUrl(config.issuer, "issuer");
  const resource = canonicalHttpsUrl(config.resource ?? MCP_RESOURCE, "resource");
  if (config.tokenPepper.length < 32) {
    throw new Error("OAuth token pepper must contain at least 32 characters");
  }
  const authorizationRequestTtlSeconds =
    config.authorizationRequestTtlSeconds ?? 10 * 60;
  const authorizationCodeTtlSeconds = config.authorizationCodeTtlSeconds ?? 5 * 60;
  const accessTokenTtlSeconds = config.accessTokenTtlSeconds ?? 60 * 60;
  const refreshTokenTtlSeconds = config.refreshTokenTtlSeconds ?? 30 * 24 * 60 * 60;
  if (
    authorizationRequestTtlSeconds < 60 ||
    authorizationRequestTtlSeconds > 15 * 60 ||
    authorizationCodeTtlSeconds < 60 ||
    authorizationCodeTtlSeconds > 5 * 60 ||
    accessTokenTtlSeconds < 60 ||
    accessTokenTtlSeconds > 60 * 60 ||
    refreshTokenTtlSeconds < 60 ||
    refreshTokenTtlSeconds > 30 * 24 * 60 * 60
  ) {
    throw new Error("OAuth TTL configuration exceeds the supported security bounds");
  }
  return {
    pool: config.pool,
    issuer,
    resource,
    tokenPepper: config.tokenPepper,
    fetcher: (config.fetcher ?? fetch).bind(globalThis),
    now: config.now ?? (() => new Date()),
    randomBytes: config.randomBytes ?? nodeRandomBytes,
    emit: async (event) => {
      if (config.emit) await config.emit(event);
    },
    authorizationRequestTtlSeconds,
    authorizationCodeTtlSeconds,
    accessTokenTtlSeconds,
    refreshTokenTtlSeconds,
  };
}

export function isOAuthScope(value: string): value is OAuthScope {
  return OAUTH_SCOPES.includes(value as OAuthScope);
}
