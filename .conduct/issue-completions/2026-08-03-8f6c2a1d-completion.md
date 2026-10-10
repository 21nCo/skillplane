# MCP workspace and skill discovery issue completion

## Metadata

- Completed at: `2026-08-03T12:37:56Z`
- Status: PASS
- Agent name: `Codex`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git branch: `main`
- Release source commit: `4a704a5832f18ce492334ebd2ce97c5993949e65`
- Release source dirty status: clean
- Issue: `.conduct/issues/2026-08-03-231305c7-issue.md`

## Issue summary

The deployed MCP required a caller to already know a Skillplane workspace ID,
and its only catalog operation was a non-empty full-text search that could not
enumerate every accessible skill or return active unpublished skill records.

## Requirements summary

1. PASS - Authenticated workspace discovery is implemented by
   `workspaces_list`. OAuth access is derived from current workspace
   memberships, while a service principal receives only its credential-bound
   workspace. Integration and security coverage prove both boundaries.
2. PASS - Queryless skill enumeration is implemented by `skills_list` with
   strict input/output schemas, workspace selection by stable ID or slug, and
   no change to the existing ranked `skills_search` contract.
3. PASS - Skill listing uses opaque, signed, filter-bound cursors over the
   domain catalog cursor. Integration coverage exhausts multiple one-item pages
   and includes an active skill whose `currentVersion` is `null`.
4. PASS - The schemas accept exactly one workspace selector, `{ id }` or
   `{ slug }`. Schema tests reject ambiguous selectors, integration tests use a
   slug, and live production verification exercised both forms.
5. PASS - Both tools require `skills:read`; authenticated identity remains
   server-derived. Tenant isolation, strict caller declaration, stable
   structured output, and existing tool compatibility pass conformance,
   integration, and security suites.
6. PASS - Multi-workspace discovery writes one audit event per disclosed
   workspace through a single Postgres transaction. A security test injects a
   failed batch and proves the response withholds workspace data and secrets.
7. PASS - Schema, conformance, integration, security, documentation, and
   production-verifier coverage were added and all relevant repository gates
   passed.
8. PASS - MCP Worker version
   `57e08db1-5fe5-4bad-abc7-e53df1cb21b0` was deployed to
   `mcp.skillplane.dev`. Production smoke and a fresh OAuth MCP session verified
   the real deployed tool inventory and both discovery calls.

## Implementation summary

### Added

- `.conduct/issues/2026-08-03-231305c7-issue.md`
- `mcp/src/tools/catalog.ts`
- `packages/mcp-schema/src/catalog.ts`

### Modified

- `.conduct/tracker.csv`
- `README.md`
- `mcp/src/audit.ts`
- `mcp/src/auth.ts`
- `mcp/src/server.ts`
- `mcp/src/tools/index.ts`
- `mcp/src/tools/shared.ts`
- `mcp/tests/conformance/mcp.conformance.test.ts`
- `mcp/tests/integration/mcp-read.integration.test.ts`
- `mcp/tests/security/mcp-read.security.test.ts`
- `packages/mcp-schema/src/common.ts`
- `packages/mcp-schema/src/index.ts`
- `packages/mcp-schema/src/schema.test.ts`
- `scripts/test-mcp-production.mjs`

### Key changes

- Registered two new read-only MCP tools and assigned the existing
  `skills:read` OAuth/service scope.
- Added deterministic membership-aware workspace pagination and queryless skill
  pagination, including unpublished records without unpublished bundle content.
- Bound both cursor types to authenticated actor/credential and active filters.
- Extended fail-closed auditing with atomic multi-workspace batch writes.
- Updated production verification to discover its workspace rather than require
  an out-of-band workspace identifier.

No files were deleted.

## Verification summary

### Local commands

- PASS - `pnpm --filter @skillplane/mcp-schema test:unit` (21 tests).
- PASS - `pnpm --filter @skillplane/mcp... typecheck`.
- PASS - focused ESLint for modified MCP, schema, tests, and verifier files.
- PASS - `pnpm --filter @skillplane/mcp test:integration` (14 tests).
- PASS - `pnpm --filter @skillplane/mcp test:security` (23 tests).
- PASS - `pnpm test:mcp:conformance` (5 tests).
- PASS - `pnpm format:check`.
- PASS - `pnpm lint`.
- PASS - `pnpm typecheck` (29 successful tasks).
- PASS - `pnpm test:unit` (29 successful tasks).
- PASS - `pnpm test:integration` (24 successful tasks; MCP 14 tests and API 37
  tests passed in the completed run).
- PASS - `pnpm test:security` (70 tests across email, auth, DataFn, API,
  storage, MCP, and root security suites).
- PASS - `pnpm build` (16 successful tasks).
- PASS - `pnpm deploy:check` (19 successful tasks plus production config dry
  runs for app, MCP, and landing Workers).
- PASS - `pnpm security:scan` (`PRODUCTION_SECURITY_SCAN_PASSED`, no findings).
- PASS - `pnpm client-secrets:verify` (`CLIENT_BUNDLES_SECRET_FREE`).
- PASS - `pnpm conduct:verify` before and after completion logging.
- PASS - `git diff --check` and staged diff check.

### Production safety and deployment

- PASS - `pnpm db:backup:production` created and round-trip verified an
  encrypted TLS 1.3 backup with 270 restore entries.
- PASS - `pnpm db:migrate:production` verified 15 migrations, 31 tables,
  constraints, triggers, and required query plans; `applied` was empty.
- PASS - `pnpm deploy:mcp` promoted source commit `4a704a5` from prior version
  `009fb9c5-bda4-476c-b819-a227dbbe987d` to release version
  `57e08db1-5fe5-4bad-abc7-e53df1cb21b0`.
- PASS - `pnpm smoke:production` returned HTTP 200 for landing/app, the expected
  authenticated HTTP 401 boundary for MCP, and ready Postgres/R2/config checks.

### Live OAuth MCP verification

- PASS - A temporary loopback OAuth client requested only `skills:read`; the
  real production account authorized it through the Skillplane consent UI.
- PASS - The official MCP SDK negotiated protocol `2025-11-25` with server
  `skillplane` version `1.0.0` and advertised exactly 11 expected tools,
  including `workspaces_list` and `skills_list`.
- PASS - `workspaces_list` discovered one authorized workspace without an
  identifier. `skills_list` exhausted all pages for that workspace without a
  query and separately resolved both its stable ID and slug.
- The verified production workspace currently contained zero active skills;
  the four-record local integration fixture proves published, private, public,
  and unpublished record enumeration.
- The verifier revoked its temporary refresh-token family after the check and
  removed its temporary local helper.

## Notes

- The first repository-wide parallel integration attempt hit one transient
  generic API 500 in the amendments suite. The exact API integration package
  passed immediately in isolation, and the complete repository integration
  matrix then passed on rerun.
- The first deployment attempt stopped before upload because the migration
  safety proof exceeded its two-hour freshness window. A new verified backup
  and no-op migration verification refreshed the required proof.
- The checked-in production verifier could not run directly because no OAuth
  access-token environment variable was present. Verification therefore used a
  fresh, least-privilege OAuth grant and the same official MCP SDK contract.
- Existing MCP clients keep the previous schema until they reconnect or refresh
  their MCP tool inventory.

## Blockers

None.
