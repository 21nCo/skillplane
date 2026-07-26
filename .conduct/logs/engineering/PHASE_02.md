# Engineering log: PHASE_02 Postgres, DataFn, and Hono data foundation

- Timestamp: 2026-07-26T05:31:51Z
- Operation: authoritative schema, tenant-filtered data access, HTTP
  composition, and recovery verification
- Result: complete

## Scope completed

1. Added `@skillplane/domain`, `@skillplane/db`, and `@skillplane/datafn` as
   buildable workspace packages.
2. Integrated the released AuthFn schema contract and added the complete
   phase-owned Skillplane schema with tenant-safe composite foreign keys,
   immutable revision/audit protections, publication invariants, and indexes.
3. Added four hash-verified forward migrations, advisory-lock serialization,
   direct-local and Hyperdrive connection factories, retryable transactions,
   full-text search, and a Postgres-backed API rate limiter.
4. Added safe test-only reset and fixture tooling. The fixture path creates
   real AuthFn user/session records rather than bypassing authentication.
5. Added a typed, read-only DataFn schema and real DataFn server/client
   composition. Private queries are namespace-filtered before ranking or
   return; mutation and secret-table access are denied.
6. Added Hono success/error envelopes, request context, AuthFn and DataFn
   mounts, tenant-filtered domain routes, and the tested middleware chain:
   request ID, security headers, authentication, authorization, rate limit,
   observability.
7. Added deterministic unit, integration, security, migration, constraint,
   query-plan, and backup/restore tests.
8. Documented the local database recovery procedure and environment variables.

## Dependency decisions

- `@authfn/core@0.1.1`
- `@datafn/core@0.0.3`
- `@datafn/server@0.0.3`
- `@datafn/client@0.0.3`
- `@superfunctions/db@0.1.4`
- `drizzle-orm@0.45.2`
- `drizzle-kit@0.31.10`

All dependencies resolve from immutable releases. No external Superfunctions,
Nucleus, or UIFn worktree was modified, so no Superfunctions change log was
needed.

## Migrations and persistence

1. `0001_authfn_core.sql`
2. `0002_skillplane_domain.sql`
3. `0003_integrity_search_retention.sql`
4. `0004_fix_published_version_transition.sql`

The verifier reports 19 tables, all four migration hashes, eight protection
triggers, required constraints, and index-backed workspace/skill/version/context
plans. The backup/restore drill restored and verified the same 19 tables and
four migrations from a 76,807-byte custom-format dump.

## Verification

```sh
pnpm db:reset:test
pnpm db:migrate
pnpm db:verify
pnpm test:unit --filter @skillplane/db --filter @skillplane/domain
pnpm test:integration --filter @skillplane/datafn --filter @skillplane/api
pnpm test:security --filter tenant-foundation
pnpm typecheck
pnpm test:unit
pnpm format:check
pnpm lint
pnpm build
pnpm deploy:check
pnpm conduct:verify
pnpm boundaries:verify
pnpm client-secrets:verify
pnpm install --frozen-lockfile
pnpm db:backup:verify
```

Results:

- fresh test reset and repeated main migration: PASS;
- schema/query-plan verification: PASS, 19 tables and 4 migrations;
- focused DB/domain unit suite: PASS, 6 tests;
- DataFn/API integration suite: PASS, 6 tests;
- tenant-foundation security suite: PASS, 2 tests;
- database invariant integration suite: PASS, 4 tests;
- complete workspace unit suite: PASS, 21 tests and 13 tasks;
- typecheck: PASS, 15 tasks;
- build: PASS, 9 tasks;
- deployment dry-run: PASS, 12 tasks;
- formatting, lint, conduct, boundaries, client-secret scan, and frozen
  install: PASS;
- database backup/restore rehearsal: PASS.

## Defects found and closed

1. Postgres rejected the first generated-column search expression because its
   built-in expression was not immutable. A schema-owned immutable search
   function now feeds the GIN document.
2. The initial published-version protection trigger returned `OLD` while a
   draft was transitioning to published, silently discarding publication.
   Forward migration `0004` returns `NEW` for the allowed transition and still
   freezes published rows. Fresh and upgrade paths both pass.
3. Vitest initially rediscovered emitted tests under `dist/`. Source suites now
   explicitly exclude build output.
4. The complete unit sweep found that the MCP liveness assertion still expected
   the pre-envelope shape. It now validates the canonical envelope and request
   metadata; the complete suite passes.
5. Drizzle's unused driver declarations are not TypeScript 6 clean. Library
   checking is skipped only in packages that consume Drizzle while all
   Skillplane-owned code remains under strict checking.

## Deferred by phase boundary

- OTP email delivery belongs to PHASE_03.
- R2 skill-bundle publication and orphan cleanup belong to later persistence
  phases.
- The OAuth authorization server belongs to its dedicated AuthFn plugin phase.
- Feature UI and browser E2E remain out of scope.

## Next safe action

Begin PHASE_03 authentication, Cloudflare transactional-email adapter, OTP
session flows, and authenticated workspace selection on top of this verified
foundation.
