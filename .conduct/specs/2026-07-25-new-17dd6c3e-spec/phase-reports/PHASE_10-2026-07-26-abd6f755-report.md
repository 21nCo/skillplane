# PHASE_10 completion report

## Metadata

| Field | Value |
|---|---|
| Timestamp | `2026-07-26T11:51:22Z` |
| Agent | `unknown-agent` |
| Model | `GPT-5` |
| Launcher | `Codex Desktop` |
| Workspace | repository root |
| Environment | `Darwin arm64`, shell `zsh` |
| Git | branch `main`; no commit yet; repository working tree contains the implementation |

## Phase

`PHASE_10` — AuthFn MCP OAuth authorization server

## Status

**PASS**

A production-bounded OAuth 2.1 authorization server is implemented as a
Skillplane-owned AuthFn plugin. Discovery, public client registration and
metadata, AuthFn-backed human consent, authorization code with PKCE S256,
opaque access and rotating refresh tokens, revocation, audience/scope
verification, audit/rate-limit/redaction controls, and the consent UI are
implemented and verified.

## Requirements delivered

`AUTH-005`, `AUTH-006`, `AUTH-007`, `AUTH-008`, `MCP-001`, `OPS-004`,
`QA-001`, `QA-003`, and `QA-004`.

### AuthFn plugin boundary — PASS

- `@skillplane/authfn-mcp-oauth` owns schema, routes, runtime configuration,
  metadata, client resolution, authorization, consent, tokens, refresh,
  revocation, verification, and OAuth error mapping.
- Integration uses AuthFn's public plugin, session, and CSRF contracts.
- No AuthFn or other Superfunctions source file changed.
- Seven OAuth tables are declared through the plugin schema contract and
  created by Skillplane migration `0011_authfn_mcp_oauth.sql`.
- OAuth secret tables are explicitly excluded from DataFn's generic surface.

### Discovery and clients — PASS

- `/.well-known/oauth-authorization-server` returns the canonical issuer and
  only supported endpoints, grants, response mode, scopes, public-client
  authentication, and PKCE S256.
- `/.well-known/oauth-protected-resource` and
  `/.well-known/oauth-protected-resource/mcp` identify
  `https://mcp.skillplane.dev/mcp` and the Skillplane authorization server.
- The MCP Worker serves protected-resource metadata without requiring database
  initialization.
- HTTPS Client ID Metadata Documents require exact identifier matching and
  reject private/literal/internal targets, redirects, wrong content types,
  oversized responses, and unsafe metadata.
- Dynamic registration accepts only public authorization-code/refresh clients
  with exact safe redirect URIs and known scopes. Registration reads require
  the one-time registration credential.

### Authorization and consent — PASS

- Human grants require a current AuthFn session.
- Unauthenticated requests survive sign-in through a signed authorization
  request and a safe relative consent return path.
- Authorization requires `response_type=code`, the canonical resource, known
  scopes, an exact registered redirect, a state value, and PKCE S256.
- Consent shows client, canonical resource, requested permissions, and return
  host with explicit allow/deny actions and AuthFn CSRF protection.
- Loopback redirects are allowed only for localhost/loopback clients and
  receive a prominent UI warning.
- Denial preserves exact state, returns `access_denied`, and issues no code.

### Codes, tokens, refresh, and revocation — PASS

- Authorization codes expire within five minutes, are one-time, and are bound
  to user, client, exact redirect, resource, scopes, and S256 challenge.
- A wrong verifier is rejected without consuming an otherwise valid code;
  successful exchange atomically consumes it and replay fails.
- Opaque access tokens expire in 60 minutes and are audience- and scope-bound.
- Opaque refresh tokens rotate within a maximum 30-day family lifetime and can
  reduce but not expand scopes.
- Reuse of a consumed refresh token revokes the whole family, including
  access tokens derived from its replacement, and emits a redacted security
  audit event.
- Revocation returns success for unknown tokens and revokes either the named
  access token or refresh family.
- Internal verification derives a user principal from database state and
  rejects expired, revoked, wrong-audience, and insufficient-scope tokens.
- Bearer tokens are accepted only through the Authorization header.

### Configuration, audit, and redaction — PASS

- Production requires issuer `https://app.skillplane.dev` and an independent
  `OAUTH_TOKEN_PEPPER` of at least 32 characters.
- Missing or unsafe production OAuth configuration fails with stable
  diagnostics.
- OAuth/token responses are `no-store`.
- Registration and sensitive endpoints are rate-limited; rate-limit responses
  include `Retry-After`.
- Operational logs and audit records contain identifiers and outcomes but not
  codes, verifiers, tokens, cookies, CSRF values, or request bodies.
- Browser bundles pass the secret scan, and the environment example contains
  no usable OAuth pepper or production binding ID.

## Conformance matrix

| Surface | Positive evidence | Negative evidence | Result |
|---|---|---|---|
| authorization-server metadata | canonical endpoints/grants/scopes/S256 | OIDC discovery absent | PASS |
| protected-resource metadata | root and `/mcp` paths; MCP Worker unit test | no query bearer method advertised | PASS |
| dynamic registration | public client created and safely readable | unsafe redirects/confidential or unsupported grants rejected | PASS |
| Client ID Metadata Document | exact HTTPS identifier resolved and cached | private/internal/redirected/mismatched document rejected | PASS |
| authorization | signed AuthFn sign-in resume and trusted callback | implicit, wrong resource/scope/redirect, plain PKCE rejected | PASS |
| consent | explicit permission grant and exact callback state | CSRF failure and denial issue no code | PASS |
| authorization code | S256 exchange succeeds once | wrong verifier, client, redirect, resource, and replay fail | PASS |
| access token | 60-minute opaque token verifies for MCP resource/scopes | revoked, expired, wrong audience/scope, query transport fail | PASS |
| refresh token | rotation and scope reduction succeed | replay revokes family and rotated access | PASS |
| revocation | access and refresh-family revocation succeed | unknown token remains non-enumerating `200` | PASS |
| internal verification | server-derived user principal | caller data cannot replace principal | PASS |
| rate limit/audit | safe audit identifiers and `Retry-After` | secret values absent from audit/output | PASS |

## Attack-suite results

| Attack | Expected result | Evidence |
|---|---|---|
| remote HTTP redirect | reject registration | PASS |
| userinfo/credential redirect | reject registration | PASS |
| fragment or wildcard redirect | reject registration | PASS |
| unregistered authorization redirect | local error; never redirect attacker | PASS |
| plain PKCE | trusted OAuth error; no code | PASS |
| implicit response / unknown scope | trusted OAuth error; no code | PASS |
| wrong verifier then correct verifier | first fails; code remains usable once | PASS |
| successful code replay | `invalid_grant` | PASS |
| consent without CSRF | `access_denied` | PASS |
| Basic client authentication | `invalid_client` | PASS |
| resource confusion | verification fails | PASS |
| bearer token query parameter | rejected | PASS |
| refresh-token replay | family and derived access revoked | PASS |
| registration flood | rate-limited with `Retry-After` | PASS |
| audit/database plaintext search | no issued secret found | PASS |

## Schema and token-storage proof

Migration `0011_authfn_mcp_oauth.sql` creates:

1. `authfn_oauth_clients`
2. `authfn_oauth_client_redirect_uris`
3. `authfn_oauth_consents`
4. `authfn_oauth_authorization_requests`
5. `authfn_oauth_authorization_codes`
6. `authfn_oauth_access_tokens`
7. `authfn_oauth_refresh_tokens`

Authorization codes, access tokens, refresh tokens, and registration
credentials have only keyed-hash columns. Hash constraints require exactly 64
lowercase hexadecimal characters. The integration suite compares issued
values against every OAuth row, scans the OAuth schema for forbidden plaintext
columns, and verifies redacted audit output.

`pnpm db:migrate` applied the migration to the real local Postgres container.
`pnpm db:verify` passed with 28 required tables and 11 recorded migrations.

## Deliverables summary

### OAuth plugin

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
- `packages/authfn-mcp-oauth/src/audit.ts`
- `packages/authfn-mcp-oauth/src/config.ts`
- `packages/authfn-mcp-oauth/src/index.ts`

### Integration and application

- `packages/auth/src/oauth.ts` and AuthFn server composition
- `packages/api/src/routes/oauth-metadata.ts`
- application and MCP Worker well-known routing
- production OAuth configuration and browser-secret policy
- `packages/db/migrations/0011_authfn_mcp_oauth.sql`
- `app/src/routes/oauth/consent/+page.svelte`

### Tests and evidence

- 18 package unit tests
- 8 real Hono/AuthFn/Postgres integration tests
- 14 OAuth attack/redaction tests
- MCP Worker protected-resource metadata tests
- DataFn secret-resource tests
- one persisted Playwright consent workflow
- dark and light consent screenshots under
  `.conduct/screenshots/phase-10/`

No production source file was deleted. No Superfunctions file was changed.

## Verification summary

| Command | Result |
|---|---|
| `pnpm test:unit --filter @skillplane/authfn-mcp-oauth` | PASS — 18/18 |
| `pnpm test:integration --filter oauth` | PASS — 8/8 |
| `pnpm test:security --filter oauth` | PASS — 14/14 |
| `pnpm test:e2e --grep @oauth-consent` | PASS — 1/1 |
| `pnpm typecheck` | PASS — 25/25 tasks |
| `pnpm build --filter @skillplane/authfn-mcp-oauth --filter app` | PASS — 12/12 tasks |
| `pnpm --filter @skillplane/mcp test:unit` | PASS — 2/2 |
| `pnpm --filter @skillplane/datafn test:unit` | PASS — 3/3 |
| `pnpm db:migrate` | PASS — migration 0011 applied |
| `pnpm db:verify` | PASS — 28 tables, 11 migrations |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm boundaries:verify` | PASS |
| `pnpm client-secrets:verify` | PASS |

## Screenshot index

1. `oauth-consent-loopback-dark.png`
2. `oauth-consent-loopback-light.png`

## Remaining risks and scope

1. MCP initialization, tools, per-tool challenges, and caller-declaration
   schemas are intentionally PHASE_11 work. This phase supplies the verifier,
   resource metadata, and challenge helper they must use.
2. AUTH-007 service principals remain the separately scoped, expirable,
   revocable credentials implemented before this phase. OAuth public clients
   do not become service principals and receive no client secret.
3. OIDC claims, ID tokens, social login, device authorization, password grant,
   implicit grant, and public token introspection are intentionally absent.
4. Railway Hyperdrive ID and live Cloudflare production bindings remain
   deployment inputs; local Postgres verification is complete.
5. The production OAuth pepper must be provisioned as a Cloudflare secret and
   must not reuse the AuthFn session secret.

## Ready for next phase?

**Yes.** Every PHASE_10 deliverable, exact command, security stop-condition,
schema/token-storage proof, and screenshot requirement has current passing
evidence. No PHASE_11 tool implementation was started.

## Blockers

None.
