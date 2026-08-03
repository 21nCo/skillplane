# MCP skill-context lifecycle issue completion

## Metadata

- Completed at: `2026-08-03T13:25:25Z`
- Status: PASS
- Agent name: `Codex`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git branch: `main`
- Release source commit: `09ad0c89e0aa065cc361e94af7e351f53d8ad9f0`
- Release source dirty status: clean
- Issue: `.conduct/issues/2026-08-03-7e4b9a2c-issue.md`

## Issue summary

The MCP could read and revise context knowledge only after another client had
created the context and supplied its identifier. Agents could not discover,
create, update, archive, restore, or inspect the immutable history of the
skill-context records they depend on.

## Requirements summary

1. PASS - `contexts_list` discovers active, archived, or all authorized skill
   contexts in deterministic update order. Its signed opaque cursor is bound to
   skill, state, authenticated actor, and credential. Integration and security
   tests cover pagination and filter mismatch rejection; production listed the
   created context immediately after writes.
2. PASS - `context_create` atomically creates metadata and the first immutable
   knowledge revision. It enforces the existing context limits, caller/model
   provenance, idempotent replay, duplicate-slug conflict handling, and a
   permanent audit event in the mutation transaction.
3. PASS - `context_update` changes metadata only and requires the exact observed
   `updatedAt`. A stale production write returned
   `CONTEXT_METADATA_CONFLICT` with the current timestamp and did not overwrite
   the newer record.
4. PASS - `context_archive` and `context_restore` use exact `updatedAt`
   concurrency, replay-safe idempotency, tenant-safe resolution, and permanent
   transactional audit. Production exercised archive, stale restore rejection,
   successful restore, and final archive.
5. PASS - `context_knowledge_history` cursor-paginates immutable Markdown
   revisions with digests, learning metadata, timestamps, and safe actor,
   agent, and model provenance. Production returned revisions `2` and `1` over
   two one-item pages.
6. PASS - Existing `context_get`, `context_knowledge_update`,
   `context_notes_list`, and `context_note_upsert` remain registered and pass
   the complete integration, security, and conformance suites.
7. PASS - New reads and writes enforce `contexts:read` / `contexts:write`,
   authenticated tenant and skill ownership, strict schemas, idempotency,
   caller declarations, and fail-closed audit. Tests reject missing scopes,
   cross-skill selectors, cursor substitution, and forced audit failure.
8. PASS - Context create/update/archive/restore domain audit events are inserted
   inside the same Postgres transaction as their mutation. Security coverage
   forces the audit insert to fail and proves the context row is rolled back.
   The production Audit UI showed permanent events with the server-derived user
   and caller-declared Codex/GPT-5 identity.
9. PASS - Schema, conformance, integration, security, README, production
   verifier, deployment guard, and operational documentation coverage were
   updated. Every repository gate listed below passed.
10. PASS - Commits `da20f07`, `06d38d5`, and `09ad0c8` were pushed to
    `origin/main`. MCP Worker version
    `ce6c06de-1783-4b05-9ff6-8c6180e21d96` was deployed and a fresh
    least-privilege OAuth MCP session executed the full lifecycle against
    production.

## Implementation summary

### Added

- `.conduct/issues/2026-08-03-7e4b9a2c-issue.md`
- `mcp/src/tools/context-lifecycle.ts`
- `packages/mcp-schema/src/context-lifecycle.ts`

### Modified

- `.conduct/logs.csv`
- `.conduct/tracker.csv`
- `README.md`
- `docs/operations/deployment.md`
- `mcp/src/audit.ts`
- `mcp/src/auth.ts`
- `mcp/src/server.ts`
- `mcp/src/tools/index.ts`
- `mcp/src/tools/resolve.ts`
- `mcp/src/tools/shared.ts`
- `mcp/tests/conformance/mcp.conformance.test.ts`
- `mcp/tests/integration/mcp-mutations.integration.test.ts`
- `mcp/tests/integration/mcp-read.integration.test.ts`
- `mcp/tests/security/mcp-mutations.security.test.ts`
- `mcp/tests/security/mcp-read.security.test.ts`
- `packages/domain/src/context-knowledge.ts`
- `packages/domain/src/contexts.ts`
- `packages/domain/src/errors.ts`
- `packages/domain/src/mutation-audit.ts`
- `packages/mcp-schema/src/context-mutations.ts`
- `packages/mcp-schema/src/errors.ts`
- `packages/mcp-schema/src/index.ts`
- `packages/mcp-schema/src/mutation-schema.test.ts`
- `scripts/deploy-all.mjs`
- `scripts/deployment-self-test.mjs`
- `scripts/lib/cloudflare-production.mjs`
- `scripts/test-mcp-production.mjs`

### Key changes

- Expanded the MCP from 11 to 17 tools with a complete context lifecycle and
  identifier-free traversal from workspace to skill to context.
- Added exact timestamp concurrency and strictly monotonic context update
  timestamps so even same-transaction writes yield distinct tokens.
- Added permanent transactional domain audit for every lifecycle mutation and
  attached agent/model provenance to the initial knowledge revision.
- Kept error payloads as JSON text for `isError` tool results so official MCP
  clients that cached success output schemas can receive stable typed errors.
- Disabled production Hyperdrive SQL response caching and made deployment fail
  closed if it is re-enabled, preserving authorization and read-after-write
  consistency across Skillplane.

No committed files were deleted. The temporary OAuth verifier was removed after
revoking its refresh-token family.

## Verification summary

### Local commands

- PASS - `pnpm format:check`.
- PASS - `pnpm lint`.
- PASS - `pnpm typecheck` (29 successful tasks).
- PASS - `pnpm test:unit` (29 successful tasks; MCP schema 23 tests).
- PASS - `pnpm test:integration` (24 successful tasks; API 37 tests and MCP 15
  tests).
- PASS - `pnpm test:security` (71 tests across email, auth, DataFn, API,
  storage, MCP, and root suites; MCP 24 tests).
- PASS - `pnpm test:mcp:conformance` (5 tests; exactly 17 tools).
- PASS - `pnpm build` (16 successful tasks).
- PASS - `pnpm deploy:check` (19 successful tasks and production config dry
  runs; cache-enabled Hyperdrive rejection self-test passed).
- PASS - `pnpm security:scan` (`PRODUCTION_SECURITY_SCAN_PASSED`, no findings,
  no high or critical dependency vulnerabilities).
- PASS - `pnpm client-secrets:verify` (`CLIENT_BUNDLES_SECRET_FREE`).
- PASS - `git diff --check`, staged diff checks, and clean source deployment
  checks.

### Production deployment and smoke

- PASS - The existing encrypted Railway backup and verified no-op migration
  safety records were recent and matched the production database.
- PASS - The exact Railway-backed Hyperdrive configuration was verified, then
  updated from `caching.disabled=false` to `caching.disabled=true`. A final live
  read confirmed the origin was unchanged and caching remained disabled.
- PASS - `pnpm deploy:mcp` promoted prior Worker version
  `1c6b4ace-f57d-4c0c-a3c0-0dfefe610a24` to
  `ce6c06de-1783-4b05-9ff6-8c6180e21d96` from clean commit `09ad0c8`.
- PASS - `pnpm smoke:production` returned landing/app HTTP 200, the expected MCP
  HTTP 401 bearer boundary, `POSTGRES_READY`, `R2_READY`, and `CONFIG_VALID`.

### Live OAuth MCP verification

- PASS - A fresh loopback OAuth client requested only `skills:read`,
  `contexts:read`, and `contexts:write`; the real production account reviewed
  and authorized those scopes in the Skillplane consent UI.
- PASS - The official MCP SDK negotiated protocol `2025-11-25`, server
  `skillplane` version `1.0.0`, and exactly 17 expected tools.
- PASS - MCP discovered workspace
  `workspace:baaff827-e416-48cf-97f1-cb37d9333698` and private verification
  skill `skill:b96da343-6e44-45d2-a447-51c2464a1a59` without out-of-band IDs.
- PASS - Context `context:4a6848c5-82a2-4f70-9b61-97fe74fc582e` completed create,
  replay, update, stale conflict, knowledge revision, paginated history,
  archive, stale restore, restore, final archive, and archived discovery.
- PASS - Both knowledge history records attributed the caller-declared agent
  `Codex production context verifier` and model `GPT-5`; the Audit UI displayed
  authenticated user, OAuth credential, caller identity, permanent mutation
  events, and typed conflict events.
- PASS - All partial verification contexts were archived, the temporary private
  verification skill was archived, the OAuth refresh-token family was revoked,
  the local helper was removed, and its browser tab was finalized.

## Notes

- The full integration suite initially found an HTTP compatibility bug where an
  optional concurrency token was serialized as `undefined`; normalizing it to
  `null` preserved existing app callers.
- The first fresh live client found that structured error bodies were being
  validated against success-only output schemas after `listTools`. Errors now
  retain stable JSON text bodies without incompatible structured content, and
  the regression lists tools before provoking a conflict.
- Live read-after-write verification then exposed Cloudflare Hyperdrive's
  default query cache. Skillplane now uses the existing cache-disabled
  configuration and deployment rejects configuration drift.
- Existing connected MCP clients must reconnect or refresh their tool inventory
  to see the six new tools.

## Blockers

None.
