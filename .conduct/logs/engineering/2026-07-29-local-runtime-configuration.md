# Local runtime configuration hardening

- Started: `2026-07-29T11:41:47Z`
- Status: in progress
- Scope: local Worker configuration, database lifecycle scripts, explicit
  authentication mode, and regression coverage.

## Incident evidence

- `pnpm db:up` rewrote `app/.dev.vars` and `mcp/.dev.vars` in full, retaining
  only the local runtime and database assignments.
- The app Wrangler configuration simultaneously exposed the remote
  `SEND_EMAIL` binding.
- Runtime configuration inferred that authentication was enabled from any
  authentication-related value, including the binding alone. It consequently
  rejected the incomplete configuration as `PRODUCTION_ADAPTER_INVALID` and
  blocked Postgres and R2 readiness checks.
- Reproduction under both Wrangler `4.86.0` and `4.115.0` returned the same
  failure, excluding the runtime upgrade as the cause.
- Docker Postgres remained healthy on the dedicated host port `55432`.

## Implementation boundary

1. Database lifecycle commands will update only their owned assignments and
   preserve all unrelated local Worker variables.
2. Authentication intent will be explicit rather than inferred from binding
   presence.
3. The default local Worker will not receive the production email binding.
4. Production configuration will continue to require full AuthFn, Turnstile,
   and Cloudflare Email Service configuration.
5. A one-time local initializer and regression coverage will make restarts and
   port migrations deterministic.

No Superfunctions source will be modified.

## Implementation

- Added an atomic, mode-`0600` Worker variable updater that changes only
  caller-owned assignments, preserves comments and unrelated values, and
  rejects duplicate managed assignments and symlink targets.
- Changed `db:up` to own only `RUNTIME_ENV`, `DATABASE_ADAPTER`, and
  `DATABASE_URL`; it no longer replaces either Worker's complete `.dev.vars`
  file.
- Added idempotent `local:init` initialization for a stable AuthFn secret,
  one shared OAuth token pepper, and a paired local Turnstile configuration.
  Secret values are never included in command output.
- Replaced inferred local authentication with explicit `AUTH_MODE=disabled`
  or `AUTH_MODE=otp`. Preview and production remain fail-closed and require
  OTP mode with complete provider configuration.
- Split local app authority between the default binding-minimal Wrangler
  configuration and `wrangler.auth.jsonc`, which alone receives the remote
  Cloudflare Email Service binding.
- Made Worker development commands build the app and its transitive workspace
  dependencies before Wrangler starts, preventing stale compiled
  configuration code from surviving a restart.
- Added regression tests for port selection, non-destructive variable
  updates, local secret initialization, and parity between the two Wrangler
  configurations.

## Verification

- All 15 local runtime regression tests pass.
- All 13 `packages/config` tests pass.
- Workspace lint, formatting, and all 29 typecheck tasks pass; Svelte reports
  zero errors and warnings.
- All 19 deployment checks and the app, MCP, and landing production dry-runs
  pass. The production app has explicit OTP mode, while the MCP Worker
  remains OAuth-only and has no email or AuthFn OTP authority.
- `pnpm db:up` left both initialized `.dev.vars` files byte-for-byte
  unchanged. Their before-and-after SHA-256 hashes were
  `9e536c190be547a79ca74c67d6e1f95b787e8d0a2d741e3a5ef643b732c62f18`
  for the app and
  `2704b1c44c08f0e2fc86db99d8f38d47853ca97828c4fc4f958e4bce8114f4fb`
  for MCP.
- Default local mode and authenticated local mode each returned HTTP 200 from
  `/api/v1/health/ready`, with configuration, Postgres, and R2 all ready.
- The default app Worker was restarted on port `5173` and returned HTTP 200
  after the final compiled-configuration correction.
- Conduct structure, append-only, and portability verification passes.

## Remaining unrelated gate

The aggregate `pnpm test:unit` command reaches the new regression tests
successfully, then stops in the pre-existing database migration inventory
test. `packages/db/src/migrate.test.ts` expects migrations `0001` through
`0012`, while the committed migration loader also finds `0013`, `0014`, and
`0015`. No database migration or migration-test source was changed in this
scope.

## Completion

- Completed: `2026-07-29T11:57:43Z`
- Status: complete for local runtime configuration hardening.
- Superfunctions changes: none.

## 2026-08-03 release-gate addendum

- Updated the migration inventory regression expectation to include the three
  already-committed migrations `0013` through `0015`; the complete unit suite
  now passes.
- Preserved retryable PostgreSQL serialization and deadlock causes as concrete
  `Error` instances when audit writes fail, satisfying both transaction retry
  behavior and the production lint policy.
- Revalidated formatting, lint, all 29 typecheck tasks, all 29 unit-test tasks,
  the 19 Worker deployment checks, and all three production configuration dry
  runs before creating the production release commit.
- Superfunctions changes: none.
