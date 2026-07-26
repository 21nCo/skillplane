# PHASE_10 engineering log

- Started: `2026-07-26T11:12:00Z`
- Completed: `2026-07-26T11:51:22Z`
- Status: `COMPLETE — PASS`
- Scope: Skillplane-owned AuthFn OAuth 2.1 plugin, discovery, public client
  registration and metadata, authorization code with PKCE S256, AuthFn-backed
  consent, opaque access and rotating refresh tokens, revocation, internal
  verification, audit/rate-limit/redaction controls, and consent UI.

## Implemented

1. Added `@skillplane/authfn-mcp-oauth` as an isolated package composed
   through AuthFn's public schema, route, runtime, session, and CSRF contracts.
2. Added seven plugin-owned OAuth tables for clients, redirect URIs, consents,
   authorization requests, authorization codes, access tokens, and refresh
   tokens.
3. Added authorization-server metadata and both MCP protected-resource
   metadata paths, including header-only bearer support and a reusable
   `WWW-Authenticate` challenge helper.
4. Added strict public dynamic client registration with one-time registration
   credentials, safe registration reads, exact redirect matching, and bounded
   per-IP rate limiting.
5. Added HTTPS Client ID Metadata Document resolution with exact `client_id`
   matching, content-type and response-size checks, manual redirect handling,
   timeouts, and private/literal-address rejection.
6. Added signed authorization-request preservation through AuthFn sign-in,
   exact callback state, AuthFn CSRF checks, and explicit consent approval or
   denial.
7. Added five-minute, one-time authorization codes bound to client, redirect,
   resource, scopes, and PKCE S256. A wrong verifier does not destroy a code;
   successful redemption consumes it atomically.
8. Added opaque 60-minute access tokens and rotating refresh tokens within a
   fixed 30-day family lifetime. Concurrent or later reuse revokes the entire
   family and emits a redacted security audit event.
9. Added standards-shaped token and revocation errors, `no-store` responses,
   unknown-token revocation success, and internal access-token verification
   that derives the user principal from server data.
10. Added production configuration validation for the canonical issuer and a
    separate 32-byte-or-longer OAuth pepper. The pepper is scanned out of
    browser bundles and is blank in the committed environment example.
11. Added a Linear-inspired Svelte consent view using shared design tokens and
    Phosphor icons. It shows client, resource, exact scopes, redirect host,
    explicit approve/deny actions, and a prominent loopback warning.
12. Added unit, integration, security, MCP Worker, DataFn secrecy, and
    persisted browser coverage.

## Persistence and secret invariants

- No table contains a plaintext authorization code, access token, refresh
  token, or registration credential column.
- Secret material is represented by a `*_hash` column constrained to a
  64-character lowercase hexadecimal HMAC-SHA-256 value.
- Request payload persistence contains the signed authorization parameters,
  not issued token material.
- Refresh rotation and family revocation run inside database transactions with
  row locks.
- All OAuth tables are explicitly classified as secret in DataFn and cannot be
  queried through its generic resource surface.
- OAuth responses and metadata use `no-store`; operational output is limited
  to safe event, request, outcome, user, and client identifiers.

## Attack and conformance coverage

- Rejects remote cleartext, credential-bearing, fragment, wildcard, and
  unregistered redirect URIs.
- Rejects `plain` PKCE, implicit response type, confidential client
  authentication, unknown scopes, resource confusion, token query parameters,
  Basic authentication, wrong client/redirect/resource, code replay, consent
  without CSRF, and unsafe Client ID Metadata URLs.
- Rejects mismatched token audience or insufficient scope during internal
  verification.
- Detects old refresh-token reuse, revokes the full family, invalidates the
  rotated access token, and records an audit event without the token.
- Rate-limits dynamic registration with stable OAuth error mapping and
  `Retry-After`.
- Deliberately returns `404` for OpenID Connect discovery because OIDC is out
  of scope.

## Defects found and closed

- Postgres parameter encoding initially treated JavaScript scope arrays as
  Postgres arrays rather than JSONB. OAuth JSON arrays are now serialized
  explicitly.
- Audit event outcome validation accepts the platform's canonical
  `success`/`denied`/`error` values; OAuth refresh-reuse events now map to that
  contract.
- The MCP Worker initially depended on application service construction to
  serve discovery. Its protected-resource metadata is now derived from
  canonical static configuration and works without database startup.
- The E2E screenshots originally used a generic evidence directory. The final
  browser run writes them under the repository's phase screenshot convention.

## Final verification

```text
pnpm test:unit --filter @skillplane/authfn-mcp-oauth
PASS — 1 file, 18 tests

pnpm test:integration --filter oauth
PASS — 1 file, 8 tests

pnpm test:security --filter oauth
PASS — 1 file, 14 tests

pnpm test:e2e --grep @oauth-consent
PASS — 1 persisted browser workflow

pnpm typecheck
PASS — 25/25 tasks

pnpm build --filter @skillplane/authfn-mcp-oauth --filter app
PASS — 12/12 tasks; Cloudflare SvelteKit output built

pnpm --filter @skillplane/mcp test:unit
PASS — 2/2

pnpm --filter @skillplane/datafn test:unit
PASS — 3/3

pnpm db:migrate
PASS — migration 0011 applied

pnpm db:verify
PASS — 28 tables and 11 migrations

pnpm lint
PASS

pnpm typecheck
PASS — 25/25 tasks

pnpm format:check
PASS

pnpm boundaries:verify
PASS — WORKSPACE_BOUNDARIES_VALID

pnpm client-secrets:verify
PASS — CLIENT_BUNDLES_SECRET_FREE
```

## External boundaries

No Superfunctions worktree or source file was modified in PHASE_10. The OAuth
server is entirely Skillplane-owned and uses AuthFn's public contracts.
