# PHASE_11 engineering log

- Started: `2026-07-26T11:52:00Z`
- Completed: `2026-07-26T12:27:09Z`
- Status: `COMPLETE — PASS`
- Scope: Streamable HTTP MCP read lifecycle, OAuth and service credential
  authorization, strict caller schemas, skill search/retrieval/assets/version
  history, context knowledge/notes, exact R2 integrity, opaque cursors,
  credential-bound downloads, audit, daily metrics, and protocol/security
  verification.

## Implemented

1. Added `@skillplane/mcp-schema` with strict, reusable Zod input/output
   contracts for complete caller declarations, stable errors, selectors,
   manifests, search, retrieval, assets, version history, context reads, and
   note pagination.
2. Locked `@modelcontextprotocol/sdk` to stable `1.29.0` and implemented a
   dedicated Hono Worker using the Web Standard Streamable HTTP transport.
3. Implemented stateless per-request server/transport instances, JSON response
   mode, protocol negotiation, protected-resource discovery, secure no-store
   responses, and explicit stale session rejection.
4. Implemented header-only OAuth `spo_` and service-principal `sps_`
   authentication. OAuth verification is resource-bound; service credentials
   are hash-only, expirable, revocable, role-bound, and explicitly scoped.
5. Added request preflight scope enforcement so insufficient credentials
   return HTTP `403` and a scope-bearing standards challenge before tool
   execution.
6. Registered exactly six tools:
   `skills_search`, `skill_retrieve`, `skill_asset_retrieve`,
   `skill_versions_list`, `context_get`, and `context_notes_list`.
7. Implemented authorization-filtered Postgres full-text search with workspace,
   visibility, tag, archive, score, and opaque cursor predicates inside the
   query boundary.
8. Implemented stable skill ID or workspace/skill slug selectors and exact
   current, version ID, semantic version, or revision selectors.
9. Implemented R2 retrieval that verifies repository digest, re-canonicalizes
   the archive, compares canonical bytes, verifies exact bundle digest, and
   compares the immutable database manifest before returning instructions.
10. Implemented context composition from an exact authorized knowledge
    revision and active shared note revisions without mutating either
    resource.
11. Implemented UTF-8 text and base64 size gates plus five-minute signed
    download grants bound to credential, caller, resource, version, bundle,
    file digest, path, request, and expiry.
12. Implemented HMAC-signed, purpose- and filter-bound cursors with separate
    invalid-signature and filter-mismatch error codes.
13. Implemented attributable audit events with server-derived principal and
    credential, complete caller declaration, resource/version/context,
    request, outcome, error, latency, and 90-day detailed-read retention class.
14. Made detailed audit a disclosure precondition through
    `persistMcpAudit`. Daily metrics commit separately so analytics failure
    cannot undo an already durable access event.
15. Added migration `0012_service_principal_audit_identity.sql` so
    organization-owned agents without delegated users can retain paired
    caller agent/model dimensions without fabricating a human user.
16. Added production-realistic test fixtures that create canonical
    R2-backed skills, candidates, contexts, notes, service credentials, and
    complete interactive OAuth grants against local Postgres.
17. Added root logical suites for `mcp-read` integration/security and a
    dedicated `test:mcp:conformance` gate.

## Tool contracts

| Tool | Required scope | Key output |
|---|---|---|
| `skills_search` | `skills:read` | stable skill/current version/digest and cursor |
| `skill_retrieve` | `skills:read`; add `contexts:read` when contextual | exact manifest, instructions, files, optional context |
| `skill_asset_retrieve` | `skills:read` | exact text, base64, or authenticated download |
| `skill_versions_list` | `skills:read` | immutable authorized history and learning summary |
| `context_get` | `contexts:read` | exact context knowledge and optional active notes |
| `context_notes_list` | `contexts:read` | deterministic versioned shared-note page |

All six advertise object-rooted JSON Schema and:

```text
readOnlyHint=true
destructiveHint=false
idempotentHint=true
openWorldHint=false
```

## Security and privacy invariants

- Principal and credential identity are derived exclusively from the bearer
  credential.
- Caller-supplied `userId` is rejected as an unknown field and cannot alter
  authorization.
- Private authorization occurs before R2 access; unsafe paths fail before R2
  access.
- Public cross-workspace access is limited to published public skill content;
  contexts and candidate history always require workspace authorization.
- Service candidate access requires both editor-or-higher role and
  `skills:amend`.
- Download grants are bearer-like, short-lived, not logged, and usable only by
  the credential that requested them.
- R2 failure never falls back to a different version or stale content.
- Tool errors contain stable code, safe message, retryability, and request ID;
  stack traces, SQL, provider text, object keys, and secrets are absent.
- Audit failure withholds content and returns `AUDIT_WRITE_FAILED`.
- Operational logs contain IDs and outcomes only, never skill instructions,
  context bodies, bearer values, grants, or database credentials.

## Defects found and closed

1. Added workspace scoping to the public search SQL before ranking and cursor
   calculation.
2. Corrected the audit identity constraint for non-delegated service
   principals.
3. Replaced an SDK-incompatible root output union with an object-rooted refined
   asset contract.
4. Normalized generic audit backend exceptions to
   `AUDIT_WRITE_FAILED`.
5. Separated daily metric failure from the durable detailed audit.
6. Established download audit scope before credential-binding denial.
7. Added R2 read counters to the test binding to prove schema/path failures
   perform zero object reads.
8. Updated the migration-chain assertion to include migrations 0011 and 0012.

## Final verification

```text
pnpm test:unit --filter @skillplane/mcp-schema
PASS — 1 file, 16 tests

pnpm test:integration --filter mcp-read
PASS — 1 file, 7 tests

pnpm test:security --filter mcp-read
PASS — 1 file, 14 tests

pnpm test:mcp:conformance
PASS — 1 file, 5 tests; protocol 2025-11-25

pnpm build --filter mcp
PASS — 12/12 tasks; Worker dry run complete

pnpm --filter @skillplane/db test:unit
PASS — 2 files, 4 tests

pnpm lint
PASS

pnpm typecheck
PASS — 27/27 tasks

pnpm format:check
PASS

pnpm db:migrate
PASS — migration 0012 applied

pnpm db:verify
PASS — 28 tables and 12 migrations

pnpm boundaries:verify
PASS — WORKSPACE_BOUNDARIES_VALID

pnpm client-secrets:verify
PASS — CLIENT_BUNDLES_SECRET_FREE
```

## Evidence

- Verification:
  `.conduct/evidence/phase-11/verification.md`
- Decision:
  `.conduct/decisions/DECISION-0004-mcp-read-transport-and-integrity.md`
- Observations:
  `.conduct/observations/2026-07-26-phase-11-mcp-reads.md`
- Completion report:
  `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_11-2026-07-26-23fdb294-report.md`

## External boundaries

No Superfunctions worktree or source file was modified. No production
Cloudflare or Railway state changed. No MCP mutation tool from PHASE_12 was
started.
