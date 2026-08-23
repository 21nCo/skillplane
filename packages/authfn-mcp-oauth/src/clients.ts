import { isIP } from "node:net";
import type { PoolClient } from "pg";
import { consumeRateLimit } from "@skillplane/db";
import { isOAuthScope, type OAuthRuntime } from "./config.js";
import { oauthRequestId, writeOAuthClientDeletionAudit } from "./audit.js";
import { OAuthError } from "./errors.js";
import { id, keyedHash, randomOpaqueSecret, secureEqual } from "./tokens.js";

export interface OAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: "none";
  readonly source: "dynamic" | "client_metadata";
}

export interface ClientRegistrationInput {
  readonly client_name?: unknown;
  readonly redirect_uris?: unknown;
  readonly token_endpoint_auth_method?: unknown;
  readonly grant_types?: unknown;
  readonly response_types?: unknown;
  readonly scope?: unknown;
}

export interface ClientRegistrationResult extends OAuthClient {
  readonly registrationAccessToken: string;
  readonly registrationClientUri: string;
  readonly clientIdIssuedAt: number;
}

interface ClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly source: "dynamic" | "client_metadata";
  readonly token_endpoint_auth_method: "none";
  readonly created_at: Date;
}

const LOCAL_REDIRECT_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);
const PRIVATE_IPV4 = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^192\.168\./,
  /^172\.(?:1[6-9]|2\d|3[01])\./,
  /^0\./,
];

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe80:")
  ) {
    return true;
  }
  return (
    isIP(normalized) === 4 && PRIVATE_IPV4.some((pattern) => pattern.test(normalized))
  );
}

export function validateRedirectUri(value: unknown): string {
  if (typeof value !== "string" || value.length > 2048) {
    throw new OAuthError(
      "invalid_client",
      "Every redirect URI must be an absolute URL",
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError(
      "invalid_client",
      "Every redirect URI must be an absolute URL",
    );
  }
  const local = url.protocol === "http:" && LOCAL_REDIRECT_HOSTS.has(url.hostname);
  if (
    (!local && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.hash ||
    value.includes("*")
  ) {
    throw new OAuthError(
      "invalid_client",
      "Redirect URIs require HTTPS, except exact loopback HTTP addresses",
    );
  }
  return url.toString();
}

export function validateClientIdMetadataUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new OAuthError("invalid_client", "The client identifier is invalid");
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname === "/" ||
    isPrivateHostname(url.hostname)
  ) {
    throw new OAuthError("invalid_client", "The client metadata URL is not permitted");
  }
  return url;
}

function exactStringArray(
  value: unknown,
  field: string,
  maximum = 20,
): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > maximum ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new OAuthError("invalid_client", `${field} must be a non-empty string array`);
  }
  return [...new Set(value as string[])];
}

export function validateRegistration(input: ClientRegistrationInput): {
  readonly clientName: string;
  readonly redirectUris: readonly string[];
} {
  const clientName =
    typeof input.client_name === "string" ? input.client_name.trim() : "";
  if (clientName.length < 1 || clientName.length > 200 || /[\r\n<>]/.test(clientName)) {
    throw new OAuthError("invalid_client", "client_name is invalid");
  }
  if (
    input.token_endpoint_auth_method !== undefined &&
    input.token_endpoint_auth_method !== "none"
  ) {
    throw new OAuthError("invalid_client", "Only public clients are supported");
  }
  const grantTypes =
    input.grant_types === undefined
      ? ["authorization_code", "refresh_token"]
      : exactStringArray(input.grant_types, "grant_types");
  if (
    grantTypes.some((grant) => !["authorization_code", "refresh_token"].includes(grant))
  ) {
    throw new OAuthError("invalid_client", "The requested grant type is not supported");
  }
  const responseTypes =
    input.response_types === undefined
      ? ["code"]
      : exactStringArray(input.response_types, "response_types");
  if (responseTypes.length !== 1 || responseTypes[0] !== "code") {
    throw new OAuthError("invalid_client", "Only the code response type is supported");
  }
  if (input.scope !== undefined) {
    if (
      typeof input.scope !== "string" ||
      input.scope
        .split(" ")
        .filter(Boolean)
        .some((scope) => !isOAuthScope(scope))
    ) {
      throw new OAuthError(
        "invalid_scope",
        "The client requested an unsupported scope",
      );
    }
  }
  return {
    clientName,
    redirectUris: exactStringArray(input.redirect_uris, "redirect_uris").map(
      validateRedirectUri,
    ),
  };
}

async function readClient(
  client: Pick<PoolClient, "query">,
  clientId: string,
): Promise<OAuthClient | null> {
  const result = await client.query<ClientRow>(
    `SELECT client_id, client_name, source, token_endpoint_auth_method, created_at
       FROM authfn_oauth_clients
      WHERE client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const redirects = await client.query<{ redirect_uri: string }>(
    `SELECT redirect_uri
       FROM authfn_oauth_client_redirect_uris
      WHERE client_id = $1
      ORDER BY redirect_uri`,
    [clientId],
  );
  return {
    clientId: row.client_id,
    clientName: row.client_name,
    source: row.source,
    tokenEndpointAuthMethod: row.token_endpoint_auth_method,
    redirectUris: redirects.rows.map((redirect) => redirect.redirect_uri),
  };
}

async function hydrateMetadataClient(
  runtime: OAuthRuntime,
  clientId: string,
): Promise<OAuthClient> {
  const metadataUrl = validateClientIdMetadataUrl(clientId);
  const response = await runtime.fetcher(metadataUrl, {
    method: "GET",
    redirect: "manual",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok || response.status >= 300 || response.status < 200) {
    throw new OAuthError(
      "invalid_client",
      "The client metadata document is unavailable",
    );
  }
  if (
    !response.headers.get("content-type")?.toLowerCase().includes("application/json")
  ) {
    throw new OAuthError("invalid_client", "The client metadata document must be JSON");
  }
  const length = Number(response.headers.get("content-length") ?? "0");
  if (length > 65_536) {
    throw new OAuthError("invalid_client", "The client metadata document is too large");
  }
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > 65_536) {
    throw new OAuthError("invalid_client", "The client metadata document is too large");
  }
  let body: ClientRegistrationInput & { readonly client_id?: unknown };
  try {
    body = JSON.parse(text) as ClientRegistrationInput & {
      readonly client_id?: unknown;
    };
  } catch {
    throw new OAuthError("invalid_client", "The client metadata document is invalid");
  }
  if (body.client_id !== clientId) {
    throw new OAuthError(
      "invalid_client",
      "The client metadata identifier does not match",
    );
  }
  const validated = validateRegistration(body);
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    await database.query(
      `INSERT INTO authfn_oauth_clients
         (client_id, client_name, source, token_endpoint_auth_method)
       VALUES ($1, $2, 'client_metadata', 'none')
       ON CONFLICT (client_id)
       DO UPDATE SET client_name = EXCLUDED.client_name,
                     updated_at = now()`,
      [clientId, validated.clientName],
    );
    await database.query(
      "DELETE FROM authfn_oauth_client_redirect_uris WHERE client_id = $1",
      [clientId],
    );
    for (const redirectUri of validated.redirectUris) {
      await database.query(
        `INSERT INTO authfn_oauth_client_redirect_uris (id, client_id, redirect_uri)
         VALUES ($1, $2, $3)`,
        [id("ocru_", runtime.randomBytes), clientId, redirectUri],
      );
    }
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
  return {
    clientId,
    clientName: validated.clientName,
    source: "client_metadata",
    tokenEndpointAuthMethod: "none",
    redirectUris: validated.redirectUris,
  };
}

export async function resolveClient(
  runtime: OAuthRuntime,
  clientId: string,
  options: { readonly refreshMetadata?: boolean } = {},
): Promise<OAuthClient> {
  if (clientId.length > 2048) {
    throw new OAuthError("invalid_client", "The client identifier is invalid");
  }
  const existing = await readClient(runtime.pool, clientId);
  if (existing && (!clientId.startsWith("https://") || !options.refreshMetadata)) {
    return existing;
  }
  if (clientId.startsWith("https://")) {
    return hydrateMetadataClient(runtime, clientId);
  }
  throw new OAuthError("invalid_client", "The OAuth client is not registered");
}

export async function registerClient(
  runtime: OAuthRuntime,
  input: ClientRegistrationInput,
  request: Request,
): Promise<ClientRegistrationResult> {
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-register:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    10,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    throw new OAuthError(
      "temporarily_unavailable",
      "Client registration is temporarily rate limited",
      429,
      rate.retryAfterSeconds,
    );
  }
  const validated = validateRegistration(input);
  const clientId = id("spclient_", runtime.randomBytes);
  const registrationAccessToken = randomOpaqueSecret("srr_", runtime.randomBytes);
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    await database.query(
      `INSERT INTO authfn_oauth_clients
         (client_id, client_name, source, token_endpoint_auth_method,
          registration_access_token_hash)
       VALUES ($1, $2, 'dynamic', 'none', $3)`,
      [
        clientId,
        validated.clientName,
        keyedHash(registrationAccessToken, runtime.tokenPepper),
      ],
    );
    for (const redirectUri of validated.redirectUris) {
      await database.query(
        `INSERT INTO authfn_oauth_client_redirect_uris (id, client_id, redirect_uri)
         VALUES ($1, $2, $3)`,
        [id("ocru_", runtime.randomBytes), clientId, redirectUri],
      );
    }
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
  return {
    clientId,
    clientName: validated.clientName,
    redirectUris: validated.redirectUris,
    tokenEndpointAuthMethod: "none",
    source: "dynamic",
    registrationAccessToken,
    registrationClientUri: `${runtime.issuer}/auth/oauth/register/${encodeURIComponent(
      clientId,
    )}`,
    clientIdIssuedAt: Math.floor(runtime.now().getTime() / 1_000),
  };
}

export async function getRegisteredClient(
  runtime: OAuthRuntime,
  clientId: string,
  bearer: string | null,
): Promise<OAuthClient> {
  await requireRegistrationAccess(runtime, clientId, bearer);
  return resolveClient(runtime, clientId);
}

async function requireRegistrationAccess(
  runtime: OAuthRuntime,
  clientId: string,
  bearer: string | null,
): Promise<void> {
  if (!bearer?.startsWith("Bearer ")) {
    throw new OAuthError(
      "invalid_client",
      "A registration access token is required",
      401,
    );
  }
  const hash = keyedHash(bearer.slice(7), runtime.tokenPepper);
  const result = await runtime.pool.query<{
    registration_access_token_hash: string | null;
  }>(
    `SELECT registration_access_token_hash
       FROM authfn_oauth_clients
      WHERE client_id = $1 AND source = 'dynamic'`,
    [clientId],
  );
  const storedHash = result.rows[0]?.registration_access_token_hash;
  if (!storedHash || !secureEqual(storedHash, hash)) {
    throw new OAuthError(
      "invalid_client",
      "The registration access token is invalid",
      401,
    );
  }
}

export async function deleteRegisteredClient(
  runtime: OAuthRuntime,
  clientId: string,
  bearer: string | null,
  request: Request,
): Promise<void> {
  await requireRegistrationAccess(runtime, clientId, bearer);
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    await database.query(
      "DELETE FROM authfn_oauth_authorization_requests WHERE payload->>'clientId' = $1",
      [clientId],
    );
    const affectedUsers = await database.query<{ user_id: string }>(
      `SELECT DISTINCT user_id
         FROM (
           SELECT user_id FROM authfn_oauth_consents WHERE client_id = $1
           UNION SELECT user_id FROM authfn_oauth_authorization_codes WHERE client_id = $1
           UNION SELECT user_id FROM authfn_oauth_access_tokens WHERE client_id = $1
           UNION SELECT user_id FROM authfn_oauth_refresh_tokens WHERE client_id = $1
         ) affected`,
      [clientId],
    );
    await database.query(
      "UPDATE authfn_oauth_refresh_tokens SET parent_id = NULL WHERE client_id = $1",
      [clientId],
    );
    const deleted = await database.query(
      "DELETE FROM authfn_oauth_clients WHERE client_id = $1 AND source = 'dynamic'",
      [clientId],
    );
    if (deleted.rowCount !== 1) {
      throw new OAuthError("invalid_client", "The OAuth client is not registered");
    }
    await writeOAuthClientDeletionAudit(database, runtime, {
      clientId,
      requestId: oauthRequestId(request),
      affectedUserIds: affectedUsers.rows.map((row) => row.user_id),
    });
    await database.query("COMMIT");
  } catch (error) {
    await database.query("ROLLBACK");
    throw error;
  } finally {
    database.release();
  }
}
