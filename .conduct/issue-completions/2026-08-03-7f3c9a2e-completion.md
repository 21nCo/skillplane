# Issue completion: Codex OAuth refresh and complete MCP skill lifecycle

## Metadata

- Completed at: `2026-08-03T15:55:29Z`
- Status: PASS
- Agent name: `unknown-agent`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: repo root
- Environment: `Darwin arm64`, shell `zsh`
- Git: branch `main`, application commit `290c0760f7d4bcf59a3b48eefe8e8c42e92022d0`
- Git status while writing this report: dirty only for final deployment and completion evidence
- Issue: `.conduct/issues/2026-08-03-c83f1d6a-issue.md`
- Production deployment: `.conduct/deployments/2026-08-03T15-49-01-854Z-phase16-2026-08-03T15-49-01-855Z.json`

## Issue summary

Codex CLI 0.145.0 omitted the RFC 8707 `resource` parameter during OAuth
refresh, while Skillplane required it on every token request. The resulting
`invalid_request: resource must be provided exactly once` prevented all MCP
calls once the access token expired. In addition, agents could amend existing
skills but could not create or govern the rest of the skill lifecycle through
MCP.

## Requirements summary

1. **PASS — Reproduce and root-cause the Codex failure.** The connected Codex
   MCP reproduced the exact refresh error before implementation. Codex 0.145.0
   was confirmed to omit the resource parameter on refresh, while Skillplane's
   token handler required exactly one resource before dispatching the grant.
2. **PASS — Safe omitted-resource refresh.** Refresh grants may omit resource;
   the stored refresh-token audience becomes authoritative and must equal the
   configured MCP resource. Authorization-code exchange still requires exactly
   one resource. Explicit mismatches and duplicate values fail closed.
3. **PASS — OAuth regression coverage.** API integration and security tests
   cover omitted and explicit refresh resources, audience preservation, token
   rotation, scope reduction, reuse detection, audit, missing code-exchange
   resource, duplicate resources, and explicit mismatch without token
   consumption. `pnpm test:security` passed all 74 security tests; API security
   passed 36 tests.
4. **PASS — Replay-safe skill creation.** `skill_create` accepts a bounded,
   canonical file set, creates immutable published version `1.0.0`, attributes
   the caller, audits durably, and returns stable skill/version identity on
   replay. Exact duplicate and canonical path collisions fail validation.
5. **PASS — Metadata and archive lifecycle.** `skill_visibility_update`,
   `skill_archive`, and `skill_restore` require `skills:write`, idempotency keys,
   and exact `updatedAt` tokens. Durable audit and monotonic concurrency values
   are transaction-coupled.
6. **PASS — Candidate review lifecycle.** `skill_candidates_list`,
   `skill_candidate_approve`, and `skill_candidate_reject` enforce workspace
   authorization, immutable versions, exact review timestamps, filter-bound
   signed cursors, reviewer attribution, and publication audit.
7. **PASS — Amendment policy lifecycle.** Get and owner-only update tools use a
   strict policy schema, optimistic concurrency, replay-safe mutation, and
   durable audit. Publishing and policy mutation require user OAuth with
   `skills:publish`; service credentials cannot publish.
8. **PASS — Exact version comparison.** `skill_versions_diff` delegates to the
   authorization-filtered immutable domain diff and returns bounded file and
   text changes.
9. **PASS — Preserve immutable evolution.** Existing skill content remains
   immutable; `skill_amend` is still the only content-evolution operation.
   Lifecycle tools modify only skill metadata or review state.
10. **PASS — Security and protocol controls.** New tools enforce least-privilege
    scopes, workspace isolation, caller declaration plus server-derived
    identity, stable typed errors, bounded schemas, replay safety, concurrency,
    cursor binding, and fail-closed auditing. MCP security passed 25 tests.
11. **PASS — Catalog, documentation, and production coverage.** MCP now exposes
    exactly 27 tools. README usage, OAuth metadata smoke checks, conformance,
    integration, security, and production inventory checks were updated.
12. **PASS — Push, deployment, and live verification.** Application commit
    `290c076` was pushed to `origin/main`. Production app, MCP, and landing
    Workers deployed successfully, smoke passed, the previously broken Codex
    connection refreshed successfully, and a fresh OAuth SDK run completed the
    full skill lifecycle against production.

## Implementation summary

### Files added

- `.conduct/issues/2026-08-03-c83f1d6a-issue.md`
- `.conduct/issue-completions/2026-08-03-7f3c9a2e-completion.md`
- `.conduct/deployments/2026-08-03T15-49-01-854Z-phase16-2026-08-03T15-49-01-855Z.json`
- `mcp/src/tools/skill-lifecycle.ts`
- `mcp/tests/integration/mcp-skill-lifecycle.integration.test.ts`
- `packages/mcp-schema/src/skill-lifecycle.ts`

### Files modified

- `.conduct/logs.csv`
- `.conduct/tracker.csv`
- `README.md`
- `mcp/src/auth.ts`
- `mcp/src/server.ts`
- `mcp/src/tools/resolve.ts`
- `mcp/tests/conformance/mcp.conformance.test.ts`
- `mcp/tests/integration/mcp-read.integration.test.ts`
- `mcp/tests/security/mcp-mutations.security.test.ts`
- `mcp/tests/security/mcp-read.security.test.ts`
- `packages/api/tests/integration/oauth.integration.test.ts`
- `packages/api/tests/security/oauth.security.test.ts`
- `packages/authfn-mcp-oauth/src/config.ts`
- `packages/authfn-mcp-oauth/src/plugin.ts`
- `packages/authfn-mcp-oauth/src/refresh.ts`
- `packages/domain/src/amendment-policy.ts`
- `packages/domain/src/errors.ts`
- `packages/domain/src/mutation-audit.ts`
- `packages/domain/src/reviews.ts`
- `packages/domain/src/skills.ts`
- `packages/mcp-schema/src/errors.ts`
- `packages/mcp-schema/src/index.ts`
- `packages/mcp-schema/src/mutation-schema.test.ts`
- `scripts/production-smoke.mjs`
- `scripts/test-mcp-production.mjs`

### Key changes

- Moved resource strictness to grant-specific handling. Authorization-code
  exchange remains strict; refresh can derive the audience only from its
  stored, server-verified grant.
- Added OAuth scopes `skills:write` and `skills:publish`, with separate tool and
  role boundaries for skill editing versus publication governance.
- Added ten skill lifecycle tools: create, visibility, archive, restore,
  candidate list/approve/reject, policy get/update, and version diff.
- Added canonical file limits, typed lifecycle schemas, monotonic optimistic
  concurrency, mutation audit attribution, idempotency, cursor binding, and
  cross-tenant concealment.
- Corrected newly-created skill timestamps to return persisted database values,
  ensuring the returned `updatedAt` is immediately valid as a concurrency token.

## Verification summary

### Local verification

- PASS — `pnpm format:check`
- PASS — `pnpm lint`
- PASS — `pnpm typecheck` (29 successful tasks)
- PASS — `pnpm test:unit` (29 successful tasks; MCP schema 25 tests)
- PASS — `pnpm test:integration` (24 successful tasks; MCP 16 tests)
- PASS — `pnpm test:security` (74 tests; API 36, MCP 25)
- PASS — `pnpm test:mcp:conformance` (5 tests; exact 27-tool inventory)
- PASS — `pnpm build` (16 successful tasks)
- PASS — `pnpm deploy:check` (19 successful tasks and production config dry runs)
- PASS — `pnpm security:scan` (`PRODUCTION_SECURITY_SCAN_PASSED`, no findings)
- PASS — `pnpm client-secrets:verify` (`CLIENT_BUNDLES_SECRET_FREE`)
- PASS — `pnpm conduct:verify` before completion logging
- PASS — `git diff --check` and staged diff check

### Production safety and deployment

- PASS — `pnpm db:backup:production` created and round-trip verified an
  encrypted TLS 1.3 backup with 270 restore entries and three bundle references.
- PASS — `pnpm db:migrate:production` verified all 15 migrations, 31 tables,
  683 constraints, 10 triggers, and required query plans; `applied` was empty.
- PASS — `pnpm deploy:all` deployed source commit `290c076`:
  - app version `c7f077ad-5250-43a5-a556-60aee503314b`
  - MCP version `ac8f334e-2308-4b26-af87-f828831ac6fe`
  - landing version `c6832a4d-5389-4caa-be2f-37c3eda4f13a`
- PASS — deployment smoke and a separate `pnpm smoke:production` returned HTTP
  200 for landing/app, the expected authenticated HTTP 401 boundary for MCP,
  and `CONFIG_VALID`, `POSTGRES_READY`, and `R2_READY`.

### Live OAuth and MCP verification

- PASS — The pre-existing Codex 0.145 connection performed a live MCP call
  after deployment and reached the normal `WORKSPACE_FORBIDDEN` domain result;
  the prior OAuth refresh error did not recur.
- PASS — A temporary loopback OAuth client used authorization code plus S256
  PKCE with the exact MCP resource, then rotated its refresh token while
  intentionally omitting resource. The rotated token retained all six requested
  scopes and authenticated successfully to the audience-bound MCP endpoint.
- PASS — The official MCP SDK negotiated protocol `2025-11-25`, server
  `skillplane` version `1.0.0`, and exactly 27 tools.
- PASS — The production run used an owner personal workspace and verified:
  create/replay stability, review-required policy, immutable amendment,
  candidate discovery, an exact added-file diff, approval to `1.0.1`, rejection
  with preserved candidate state, workspace visibility, archive, restore, and a
  final archived verification skill.
- PASS — The verifier revoked its refresh-token family, removed its temporary
  helper, and closed its authorization tab.

## Notes

- The first `pnpm deploy:all` attempt stopped before Cloudflare mutation because
  its backup/migration safety evidence was stale. The mandated backup and
  migration verification were refreshed before the successful retry.
- `pnpm test:mcp:production` could not run because the optional
  `SKILLPLANE_PRODUCTION_MCP_ACCESS_TOKEN` was not configured. Its inventory and
  discovery coverage was superseded by the stronger fresh OAuth SDK lifecycle
  run; no token was persisted to the repository or environment file.
- Existing Codex tasks retain the tool definitions discovered when the task was
  created. A new task after OAuth reconnect is required for Codex UI discovery
  of all newly deployed tools, although the current task's old credential now
  refreshes successfully.

## Blockers

None.
