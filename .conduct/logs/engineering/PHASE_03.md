# PHASE_03 engineering log

- Timestamp: `2026-07-26T06:15:01Z`
- Phase: `PHASE_03`
- Status: `PASS` after re-verification; initially `BLOCKED`
- Scope: AuthFn email OTP, API-key authentication, secure sessions, Cloudflare
  Email Service delivery through SendFn, auth UI, and security/E2E evidence.

## Implemented

1. Added `@skillplane/email` on the released `sendfn@0.0.2` provider contract.
   The Cloudflare provider maps structured messages, sender identities,
   recipient lists, reply-to, attachments, and provider message IDs. It
   validates the documented 50-recipient, 32-attachment, and 5 MiB limits,
   classifies retryable Cloudflare failures, and emits redacted typed errors.
2. Added branded, escaped HTML and plain-text OTP and invitation renderers.
3. Added `@skillplane/auth`, composing AuthFn's email-OTP and API-key plugins
   with Postgres persistence and the SendFn delivery boundary.
4. Added forward migration `0005_authfn_otp_api_keys.sql`, schema verification,
   and AuthFn-compatible table adapters.
5. Added HMAC-backed Postgres rate limits, fail-closed Turnstile verification,
   CSRF/origin checks, secure cookie policy, non-enumerating responses, and
   redacted observability fields.
6. Mounted the auth server in the canonical Hono app and delegated SvelteKit
   auth/data requests through the server-only API composition.
7. Implemented real sign-in and verification screens with resend, expired,
   invalid, rate-limited, and recovery states in light and dark themes.
8. Added a browser harness that exercises SvelteKit, Hono, AuthFn, Postgres,
   SendFn, and a test-only Cloudflare binding contract. Test providers cannot
   enter a production bundle.

## Important decisions

- The existing Superfunctions `next` worktree already has user-owned changes in
  the SendFn package and export surfaces. It remains read-only. The local
  provider implements the released stable `EmailProvider` interface, so no
  source fork or mutable dependency was introduced.
- Production configuration requires a Cloudflare email binding, a permitted
  sender, AuthFn secrets, and Turnstile configuration. Capture/fake providers
  are rejected in production.
- OTP request responses do not expose whether an email exists and do not return
  the code. Delivery identifiers are retained only as redacted operational
  metadata.

## Verification

| Gate | Outcome |
|---|---|
| focused email/auth unit tests | PASS; 9 tests |
| `auth-otp` integration tests | PASS; 6 tests |
| auth security tests | PASS; 5 tests |
| `@auth` browser E2E | PASS; 3 tests |
| workspace build | PASS; 11 tasks |
| typecheck | PASS; 19 tasks |
| lint and formatting | PASS |
| deployment dry-runs | PASS; app email binding recognized |
| boundaries and client-secret scan | PASS |
| local Postgres migration | PASS; migration `0005` applied |
| local Postgres verification | PASS; 21 tables, 5 migrations |
| Superfunctions diff check | PASS |
| Superfunctions SendFn build | PASS |
| Superfunctions SendFn tests | FAIL; 43/44 pass, pre-existing `closeCalls` assertion |

## External verification

A temporary, ignored Worker was deployed only for a remote binding probe and
then removed. Cloudflare resolved `SEND_EMAIL` with
`auth@skillplane.dev` as an allowed sender, but a real send returned:

```text
could not find domain config of sending domain
```

No email was delivered. The account/token/binding are operational; Cloudflare
Email Service sending-domain onboarding for `skillplane.dev` remains required.
No Cloudflare or DNS configuration was mutated.

## Defects found and closed

1. Browser E2E initially raced the SvelteKit page bootstrap; readiness is now
   explicit before interaction and screenshot capture.
2. The application route originally imported Hono composition directly. A
   server-only composition module now owns that import and the workspace
   boundary verifier checks both layers.
3. Local schema verification initially reported the two new AuthFn tables
   missing. Applying the committed forward migration resolved the local runtime
   state; repeated verification now passes.
4. Test-support files exposed lint/type boundaries not used in production.
   Package build inputs and lint test globals are now scoped explicitly.

## Blockers

1. Cloudflare Email Service has not activated the `skillplane.dev` sending
   domain, so delivered-message evidence cannot pass.
2. The required read-only upstream SendFn suite fails at
   `tests/public_api.test.ts:123`, where `adapter.closeCalls` is `0` instead of
   `1`. The failure is outside Skillplane and overlaps user-owned changes.

## Next safe action

Onboard `skillplane.dev` in Cloudflare Email Service and resolve the existing
SendFn lifecycle failure in its owner worktree. Then repeat the remote delivery
probe and exact phase gates before changing this phase status.

## Re-verification — 2026-07-26T06:29:33Z

Both blockers were resolved without changing the root-domain Afternic
delegation:

1. Cloudflare Email Sending was enabled for `auth.skillplane.dev`.
   Skillplane's production sender and validation now use
   `no-reply@auth.skillplane.dev`. Cloudflare accepted the verification
   message, and a read-only Gmail search confirmed arrival in the connected
   inbox.
2. The SendFn failure traced to `@superfunctions/db` schema wrapping: object
   spread dropped class prototype lifecycle methods. A pre-logged,
   non-overlapping two-file fix explicitly delegates lifecycle/schema methods
   and adds a prototype-backed regression test. DB checks pass and SendFn is
   green at 44/44.

The final matrix also found that test rate-limit buckets shared a fixed pepper
across repeated runs. The auth harness now derives a per-environment pepper from
its existing random suffix. The auth security suite passes twice consecutively.

The authoritative successful phase report is:

```text
.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_03-2026-07-26-f6837ceb-report.md
```

PHASE_03 is ready for PHASE_04.
