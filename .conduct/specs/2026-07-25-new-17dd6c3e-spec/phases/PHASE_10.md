# PHASE_10 — AuthFn MCP OAuth authorization server

## Phase goal

Implement a production OAuth 2.1 authorization server as a Skillplane-owned AuthFn plugin without a broad AuthFn core change.

## In scope

- OAuth plugin schema and runtime.
- Authorization server and protected-resource metadata.
- Client ID metadata and dynamic registration.
- Authorization code + PKCE S256.
- Consent UI.
- Access/refresh tokens, rotation, revocation, and verification.
- MCP resource/scopes.

## Out of scope

- MCP tools.
- OpenID Connect claims and ID tokens.
- Social login.

## Deliverables

- `packages/authfn-mcp-oauth/package.json`
- `packages/authfn-mcp-oauth/src/plugin.ts`
- `packages/authfn-mcp-oauth/src/schema.ts`
- `packages/authfn-mcp-oauth/src/metadata.ts`
- `packages/authfn-mcp-oauth/src/clients.ts`
- `packages/authfn-mcp-oauth/src/authorization.ts`
- `packages/authfn-mcp-oauth/src/codes.ts`
- `packages/authfn-mcp-oauth/src/tokens.ts`
- `packages/authfn-mcp-oauth/src/refresh.ts`
- `packages/authfn-mcp-oauth/src/revocation.ts`
- `packages/authfn-mcp-oauth/src/verify.ts`
- `packages/authfn-mcp-oauth/src/errors.ts`
- `packages/authfn-mcp-oauth/src/index.ts`
- `packages/auth/src/oauth.ts`
- `packages/api/src/routes/oauth-metadata.ts`
- `app/src/routes/oauth/consent/+page.svelte`
- OAuth migrations, conformance tests, attack tests, and screenshots
- engineering decision/log, phase report, and ledger append

## Requirements covered

- `AUTH-005`
- `AUTH-006`
- `AUTH-007`
- `AUTH-008`
- `MCP-001`
- `OPS-004`
- `QA-001`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Implement the plugin against AuthFn's public schema/routes/runtime contracts.
2. Mount root metadata handlers through Hono and AuthFn routes under `/auth/oauth`.
3. Store all codes and tokens as keyed hashes with one-time issuance semantics.
4. Implement public client metadata documents and dynamic registration validation.
5. Implement signed authorization request preservation through AuthFn sign-in.
6. Build consent UI listing client, resource, and scopes with explicit approve/deny.
7. Implement authorization code TTL, exact redirect match, S256 verifier, resource binding, and state.
8. Implement 60-minute access tokens and rotating 30-day refresh tokens with family reuse detection.
9. Implement revocation and introspection-equivalent internal verification without exposing a public introspection endpoint.
10. Add rate limiting, audit events, and redaction.
11. Prove AuthFn core source changes are unnecessary; if a missing generic hook is found, stop and request approval before any shared change.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/authfn-mcp-oauth
pnpm test:integration --filter oauth
pnpm test:security --filter oauth
pnpm test:e2e --grep @oauth-consent
pnpm typecheck
pnpm build --filter @skillplane/authfn-mcp-oauth --filter app
```

Expected outcomes:

- Metadata discovery, registration, authorization, token, refresh, and revocation pass.
- Wrong PKCE, redirect, client, scope, resource, replay, and refresh reuse fail.
- Tokens are audience-bound and secret values are absent from logs/database plaintext scans.
- No broad AuthFn modification exists.

## Stop condition

Report conformance matrix, attack-suite results, schema/token storage proof, consent screenshots, and any AuthFn boundary limitation before `PHASE_11`.
