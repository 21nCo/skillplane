import { isOAuthScope, OAUTH_SCOPES, type OAuthRuntime } from "./config.js";
import { noStoreHeaders } from "./errors.js";

export interface AuthorizationServerMetadata {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly revocation_endpoint: string;
  readonly registration_endpoint: string;
  readonly scopes_supported: readonly string[];
  readonly response_types_supported: readonly ["code"];
  readonly response_modes_supported: readonly ["query"];
  readonly grant_types_supported: readonly ["authorization_code", "refresh_token"];
  readonly token_endpoint_auth_methods_supported: readonly ["none"];
  readonly code_challenge_methods_supported: readonly ["S256"];
  readonly revocation_endpoint_auth_methods_supported: readonly ["none"];
  readonly client_id_metadata_document_supported: true;
}

export interface ProtectedResourceMetadata {
  readonly resource: string;
  readonly authorization_servers: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly bearer_methods_supported: readonly ["header"];
  readonly resource_name: "Skillplane MCP";
}

export function authorizationServerMetadata(
  runtime: Pick<OAuthRuntime, "issuer">,
): AuthorizationServerMetadata {
  return {
    issuer: runtime.issuer,
    authorization_endpoint: `${runtime.issuer}/auth/oauth/authorize`,
    token_endpoint: `${runtime.issuer}/auth/oauth/token`,
    revocation_endpoint: `${runtime.issuer}/auth/oauth/revoke`,
    registration_endpoint: `${runtime.issuer}/auth/oauth/register`,
    scopes_supported: OAUTH_SCOPES,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: true,
  };
}

export function protectedResourceMetadata(
  runtime: Pick<OAuthRuntime, "issuer" | "resource">,
): ProtectedResourceMetadata {
  return {
    resource: runtime.resource,
    authorization_servers: [runtime.issuer],
    scopes_supported: OAUTH_SCOPES,
    bearer_methods_supported: ["header"],
    resource_name: "Skillplane MCP",
  };
}

export function metadataResponse(value: object): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: noStoreHeaders({
      "content-type": "application/json",
      "access-control-allow-origin": "*",
    }),
  });
}

export function protectedResourceChallenge(
  runtime: Pick<OAuthRuntime, "resource">,
  options: {
    readonly error?: "invalid_token" | "insufficient_scope";
    readonly scopes?: readonly string[];
  } = {},
): string {
  const resource = new URL(runtime.resource);
  const metadataUrl = `${resource.origin}/.well-known/oauth-protected-resource${resource.pathname}`;
  const parameters = [`resource_metadata="${metadataUrl}"`];
  if (options.error) parameters.push(`error="${options.error}"`);
  if (options.scopes?.length) {
    const scopes = options.scopes.filter(isOAuthScope);
    if (scopes.length > 0) parameters.push(`scope="${scopes.join(" ")}"`);
  }
  return `Bearer ${parameters.join(", ")}`;
}
