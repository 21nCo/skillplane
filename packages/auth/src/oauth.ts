import {
  createAuthFnMcpOAuthPlugin,
  type AuthFnMcpOAuthConfig,
} from "@skillplane/authfn-mcp-oauth";

export function createSkillplaneOAuth(config: AuthFnMcpOAuthConfig) {
  return createAuthFnMcpOAuthPlugin(config);
}

export type {
  AuthFnMcpOAuthConfig,
  OAuthRuntime,
  VerifiedOAuthPrincipal,
} from "@skillplane/authfn-mcp-oauth";
export {
  authorizationServerMetadata,
  metadataResponse,
  protectedResourceMetadata,
  protectedResourceChallenge,
  readBearerToken,
  verifyAccessToken,
} from "@skillplane/authfn-mcp-oauth";
