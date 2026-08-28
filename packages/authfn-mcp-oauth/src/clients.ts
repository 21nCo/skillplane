import {
  McpFnHostedAuthorizationError,
  normalizeMcpClientRegistration,
  type McpFnNormalizedClientRegistration,
} from "@mcpfn/auth";
import { consumeRateLimit } from "@skillplane/db";
import { isIP } from "node:net";
import type { OAuthRuntime } from "./config.js";
import { id } from "./tokens.js";

type ClientMetadata = McpFnNormalizedClientRegistration["metadata"];

interface ClientRow {
  readonly client_id: string;
  readonly client_name: string;
  readonly token_endpoint_auth_method: string;
}

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

/** Skillplane's network allow-policy; McpFn owns fetching and document validation. */
export function isClientMetadataDocumentUrlAllowed(url: URL): boolean {
  return (
    url.protocol === "https:" &&
    url.username === "" &&
    url.password === "" &&
    url.search === "" &&
    url.hash === "" &&
    url.pathname !== "/" &&
    !isPrivateHostname(url.hostname)
  );
}

export async function resolveRegisteredClient(
  runtime: OAuthRuntime,
  clientId: string,
): Promise<McpFnNormalizedClientRegistration | null> {
  if (!clientId || clientId.length > 2048 || clientId.startsWith("https://")) {
    return null;
  }
  const result = await runtime.pool.query<ClientRow>(
    `SELECT client_id, client_name, token_endpoint_auth_method
       FROM authfn_oauth_clients
      WHERE client_id = $1`,
    [clientId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const redirects = await runtime.pool.query<{ redirect_uri: string }>(
    `SELECT redirect_uri
       FROM authfn_oauth_client_redirect_uris
      WHERE client_id = $1
      ORDER BY redirect_uri`,
    [clientId],
  );
  return normalizeMcpClientRegistration({
    clientId: row.client_id,
    source: "dynamic",
    metadata: {
      client_name: row.client_name,
      redirect_uris: redirects.rows.map((redirect) => redirect.redirect_uri),
      response_types: ["code"],
      grant_types: ["authorization_code", "refresh_token"],
      token_endpoint_auth_method: row.token_endpoint_auth_method,
    },
  });
}

function normalizedClientName(metadata: ClientMetadata): string {
  const name =
    typeof metadata.client_name === "string"
      ? metadata.client_name.trim()
      : "MCP client";
  if (name.length < 1 || name.length > 200 || /[\r\n<>]/u.test(name)) {
    throw new McpFnHostedAuthorizationError(
      "invalid_client_metadata",
      "client_name is invalid",
    );
  }
  return name;
}

export async function registerClient(
  runtime: OAuthRuntime,
  metadata: ClientMetadata,
  request: Request,
): Promise<McpFnNormalizedClientRegistration> {
  const rate = await consumeRateLimit(
    runtime.pool,
    `oauth-register:${request.headers.get("cf-connecting-ip") ?? "unknown"}`,
    10,
    60,
    runtime.now(),
  );
  if (!rate.allowed) {
    throw new McpFnHostedAuthorizationError(
      "temporarily_unavailable",
      "Client registration is temporarily rate limited",
      {
        status: 429,
        details: { retryAfterSeconds: rate.retryAfterSeconds },
      },
    );
  }
  const clientId = id("spclient_", runtime.randomBytes);
  const persistedMetadata = {
    ...metadata,
    client_name: normalizedClientName(metadata),
    client_id_issued_at: Math.floor(runtime.now().getTime() / 1_000),
  } as ClientMetadata & { client_id_issued_at: number };
  const database = await runtime.pool.connect();
  try {
    await database.query("BEGIN");
    await database.query(
      `INSERT INTO authfn_oauth_clients
         (client_id, client_name, source, token_endpoint_auth_method)
       VALUES ($1, $2, 'dynamic', 'none')`,
      [clientId, persistedMetadata.client_name],
    );
    for (const redirectUri of persistedMetadata.redirect_uris) {
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
  return normalizeMcpClientRegistration({
    clientId,
    source: "dynamic",
    metadata: persistedMetadata,
  });
}
