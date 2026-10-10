# PHASE_03 successful re-verification report

## Metadata

| Field | Value |
|---|---|
| Timestamp | `2026-07-26T06:29:33Z` |
| Agent | `unknown-agent` |
| Model | `GPT-5` |
| Launcher | `Codex Desktop` |
| Workspace | `/Users/serro/Documents/dev/n/agent/experiments/skillplane` |
| Environment | `Darwin arm64`, shell `zsh` |
| Git | branch `main`; no commit yet; dirty with phase implementation |

## Phase

`PHASE_03` — AuthFn OTP and Cloudflare SendFn delivery

## Status

**PASS**

This report supersedes the status, but not the immutable evidence, of
`PHASE_03-2026-07-26-517fe91e-report.md`. Both previously external blockers are
resolved: Cloudflare transactional email was delivered through an active
Skillplane sending subdomain, and the mandatory upstream SendFn suite passes
after a pre-logged, non-overlapping minor database-wrapper fix.

## Requirements

### AUTH-001 — PASS

- AuthFn owns email-OTP creation/verification, API keys, durable Postgres
  sessions, and secure session cookies.
- Generic OTP-send responses prevent identity enumeration.
- OTP values are HMAC-protected at rest and excluded from responses/logs.
- A browser session persists after verification and page reload.

### AUTH-002 — PASS

- `@skillplane/email` implements the released SendFn provider contract with
  structured sender/recipient/body/attachment mapping, provider IDs, documented
  limits, retry classification, and redacted failures.
- Branded OTP and invitation templates provide escaped HTML and plain text.
- Production cannot select a capture/fake provider.
- Cloudflare Email Sending is active for `auth.skillplane.dev`.
- The Worker binding allows only `no-reply@auth.skillplane.dev`.
- Cloudflare accepted one non-OTP verification message and a read-only Gmail
  search confirmed actual inbox delivery.

### AUTH-003 — PASS

- CSRF/origin validation, Postgres/HMAC rate limits, fail-closed Turnstile,
  secure cookie rules, enumeration resistance, replay/expiry/attempt limits,
  and telemetry redaction are implemented and tested.
- Test rate-limit buckets now use a per-environment suffix and the complete
  security suite passes twice consecutively.

### PROJ-004 — PASS

- All original user-owned AuthFn, SendFn, delivery, package, and lockfile
  changes in the Superfunctions `next` worktree were preserved.
- The lifecycle failure was traced to two previously clean `@superfunctions/db`
  paths. The required pre/post change log records the exact scope, rationale,
  verification, generated-artifact observation, and rollback.
- No mutable external worktree enters Skillplane's dependency graph;
  Skillplane continues to consume released `sendfn@0.0.2`.

### OPS-004 — PASS

- Runtime configuration requires the Cloudflare provider/binding, exact
  Skillplane sending subdomain, AuthFn secret, and Turnstile values.
- Client bundle scanning and structured log projection exclude secrets,
  recipient addresses, OTPs, tokens, cookies, and provider payloads.
- Evidence omits account/zone IDs, recipients, subdomain tags, public key
  material, and mailbox identifiers.

### QA-001 — PASS

- Unit tests cover provider behavior, templates, auth composition, session
  cookies, and Turnstile.
- Integration tests cover real Postgres/AuthFn/SendFn composition.
- Test-only adapters cannot enter production configuration.

### QA-002 — PASS

- Three browser tests drive SvelteKit, Hono, AuthFn, Postgres, and SendFn
  through sign-in, verification, reload, invalid/expired recovery, resend, and
  rate-limit states.
- Light and dark screenshot evidence is retained under
  `.conduct/screenshots/phase-03`.

### QA-003 — PASS

- The release-blocking auth security suite covers enumeration, CSRF,
  Turnstile, rate limits, expiry, replay, attempt limits, and redaction.
- Two immediate consecutive runs passed, proving repeatable isolation.

### QA-004 — PASS

- All exact phase commands, repository-wide quality gates, real delivery
  evidence, external changes, defects, and decisions are recorded.
- The successful report, canonical pointer, engineering log, observations,
  ledger, and both append-only CSVs are linked.

## Changes since the blocked report

### Skillplane

- `.env.example`
- `app/wrangler.jsonc`
- `packages/config/src/index.ts`
- `packages/config/src/index.test.ts`
- `packages/email/src/cloudflare-provider.test.ts`
- `packages/email/tests/integration/sendfn.integration.test.ts`
- `packages/email/tests/security/redaction.test.ts`
- `packages/auth/tests/support/auth-test-environment.ts`
- `packages/testing/src/auth-browser-harness.ts`
- `.conduct/logs/engineering/PHASE_03.md`
- `.conduct/observations/2026-07-26-phase-03-auth-email.md`
- `.conduct/logs/superfunctions/2026-07-26T06-23-48Z-db-schema-lifecycle-forwarding.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_03.md`
- `.conduct/ledger.md`
- root and spec-local `logs.csv`
- this uniquely named report

The complete original PHASE_03 deliverable inventory remains recorded in the
earlier report and is unchanged except for the paths above.

### Logged minor Superfunctions fix

- `packages/db/src/adapter/schema-codecs.ts`
- `packages/db/src/adapter/__tests__/schema-codecs.test.ts`

Four ignored source-adjacent compiler artifacts for `schema-codecs` were
synchronized mechanically from the successful package build because other
pre-existing ignored JS artifacts resolve them during local Vitest execution.
They remain ignored and absent from Git status.

## Cloudflare evidence

Root-domain enablement was rejected because `_domainkey.skillplane.dev` is
delegated to Afternic. That delegation was preserved. Wrangler 4.114.0 then
successfully:

1. enabled Email Sending for `auth.skillplane.dev`;
2. reported the sending subdomain enabled with return-path, SPF, DKIM, and
   DMARC records;
3. accepted a message from `no-reply@auth.skillplane.dev`.

A Gmail-native exact sender/subject search found that verification message in
the connected inbox. No message or mailbox state was modified by the search.

## Exact phase verification

| Command | Outcome |
|---|---|
| `pnpm test:unit --filter @skillplane/email --filter @skillplane/auth` | PASS; 9 tests |
| `pnpm test:integration --filter auth-otp` | PASS; 6 tests |
| `pnpm test:security --filter auth` | PASS; 5 tests; repeated twice |
| `pnpm test:e2e --grep @auth` | PASS; 3 tests in 16.9 seconds |
| `pnpm build` | PASS; 11 tasks |
| `git -C "$SENDFN_WORKTREE" diff --check` | PASS |
| `npm --prefix "$SENDFN_WORKTREE/sendfn/typescript" test -- --run` | PASS; 44 tests |
| `npm --prefix "$SENDFN_WORKTREE/sendfn/typescript" run build` | PASS; CJS, ESM, DTS |

## Additional verification

| Command | Outcome |
|---|---|
| Superfunctions DB focused test | PASS; 6 tests |
| Superfunctions DB typecheck/build | PASS |
| `pnpm typecheck` | PASS; 19 tasks |
| `pnpm lint` | PASS |
| `pnpm format:check` | PASS |
| `pnpm boundaries:verify` | PASS; `WORKSPACE_BOUNDARIES_VALID` |
| `pnpm client-secrets:verify` | PASS; `CLIENT_BUNDLES_SECRET_FREE` |
| `pnpm deploy:check` | PASS; 14 tasks; exact sender recognized |
| `pnpm db:verify` | PASS; 21 tables, 5 migrations |
| `pnpm install --frozen-lockfile` | PASS; 12 workspaces |

## Defects closed during re-verification

1. Root-domain Email Sending conflicted with an existing Afternic
   `_domainkey` delegation. A dedicated transactional subdomain avoids the
   conflict without deleting DNS.
2. `wrapWithSchema()` relied on object spread, which drops class prototype
   lifecycle methods. Explicit delegation plus a prototype-backed regression
   test restores correct close and schema lifecycle behavior.
3. Old ignored JS beside the DB TypeScript source shadowed the patched source in
   local Vite resolution. The exact artifact quartet was synchronized from the
   successful build; tracked source remains authoritative.
4. Repeated auth security runs reused network rate-limit buckets because the
   test pepper was global. The harness now keys each environment independently.

## Notes

1. Railway remains the production Postgres origin.
2. The Hyperdrive ID remains a PHASE_16 deployment dependency.
3. The root-domain Afternic delegation is unchanged.
4. One harmless non-OTP verification email was sent to the authenticated
   account and left unread.
5. The Superfunctions fix is intentionally uncommitted with all existing
   user-owned worktree changes.
6. The earlier blocked report remains unchanged as historical evidence.

## Ready for next phase?

**Yes.** PHASE_03 is complete and PHASE_04 may begin.
