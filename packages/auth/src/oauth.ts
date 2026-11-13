import {
  createAuthFnMcpOAuthPlugin,
  type AuthFnMcpOAuthConfig,
} from "@skillplane/authfn-mcp-oauth";

export function createSkillplaneOAuth(config: AuthFnMcpOAuthConfig) {
  return createAuthFnMcpOAuthPlugin(config);
}

export type {
  AuthFnMcpOAuthConfig,
  ConsentRevocationResult,
  OAuthConnection,
  OAuthRuntime,
  VerifiedOAuthPrincipal,
} from "@skillplane/authfn-mcp-oauth";
export {
  authorizationServerMetadata,
  listConsents,
  metadataResponse,
  protectedResourceMetadata,
  protectedResourceChallenge,
  readBearerToken,
  revokeConsent,
  verifyAccessToken,
} from "@skillplane/authfn-mcp-oauth";
