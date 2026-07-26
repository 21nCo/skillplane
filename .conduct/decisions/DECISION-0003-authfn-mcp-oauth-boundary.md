# DECISION-0003: AuthFn MCP OAuth ownership and token boundary

- Status: accepted
- Date: 2026-07-26

## Context

Skillplane needs an OAuth 2.1 authorization server for remote MCP clients.
AuthFn already exposes public schema, route, runtime, session, and CSRF
contracts, but it does not need to own Skillplane's OAuth policy or persistence.
The authorization server must support discovery, public clients, consent,
authorization code with PKCE S256, audience-bound tokens, rotation, revocation,
and internal verification without turning caller claims into authenticated
identity.

The MCP endpoint also needs protected-resource metadata without requiring the
MCP Worker to open a database connection during discovery.

## Decision

1. Skillplane owns the OAuth implementation in
   `packages/authfn-mcp-oauth`. It composes only AuthFn's public plugin,
   session, and CSRF contracts; no Superfunctions/AuthFn core source is
   modified.
2. The authorization server issuer is `https://app.skillplane.dev`, and the
   only production resource is `https://mcp.skillplane.dev/mcp`.
3. OAuth clients are public clients. Client ID Metadata Documents are accepted
   only over safe HTTPS URLs with exact identifier matching; strict dynamic
   registration remains available for clients that need it.
4. Authorization codes, registration credentials, access tokens, and refresh
   tokens are opaque values stored only as keyed HMAC-SHA-256 hashes. The
   OAuth pepper is distinct from the AuthFn session secret and is required in
   production.
5. Authorization codes are one-time, expire within five minutes, require exact
   client/redirect/resource binding, and require PKCE S256. Access tokens live
   for 60 minutes. Refresh tokens rotate within a family bounded to 30 days;
   replay revokes the family.
6. Internal token verification creates the authenticated user principal from
   database state. Agent, model, client-run, and delegated-user declarations
   remain separate caller metadata supplied by later MCP tools.
7. OAuth persistence uses the existing Postgres pool directly for atomic
   one-time exchanges, row locking, and refresh-family revocation. All
   plugin-owned tables are explicitly excluded from DataFn exposure.
8. Authorization-server metadata is mounted through the application Hono
   composition. Protected-resource metadata has an equivalent static,
   configuration-derived path in the MCP Worker so discovery remains
   database-independent.
9. OAuth and token responses are `no-store`; rate-limit failures include
   `Retry-After`; security logs and audit events contain identifiers and
   outcomes but never codes, tokens, verifiers, request payloads, or
   registration credentials.

## Consequences

- OAuth can evolve as a Skillplane package without a broad AuthFn change.
- A production deployment must provide a unique `OAUTH_TOKEN_PEPPER`; this is
  a deployment input, not a local implementation blocker.
- MCP tools must use the internal verifier and authorization challenge helper
  in PHASE_11. They must not accept bearer tokens in query parameters or
  derive a principal from caller-declared user fields.
- OpenID Connect discovery, ID tokens, social login, and public token
  introspection are intentionally absent.
- Railway/Hyperdrive configuration does not alter OAuth persistence semantics;
  it supplies the production Postgres connection in the deployment phase.

## Verification

Unit, integration, security, and browser suites prove metadata, registration,
Client ID Metadata Documents, sign-in preservation, consent, PKCE, one-time
codes, token rotation, family replay revocation, audience checks, rate limits,
CSRF, audit redaction, and the absence of plaintext token columns.
