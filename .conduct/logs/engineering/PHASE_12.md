# PHASE_12 engineering log

- Started: `2026-07-26T12:27:10Z`
- Completed: `2026-07-26T12:53:30Z`
- Status: `COMPLETE — PASS`
- Scope: MCP skill amendments, context knowledge updates, context note
  create/update, exact scopes and roles, domain policy, learning provenance,
  optimistic concurrency, idempotency, stable errors, and transactional audit.

## Implemented

1. Added strict amendment schemas for caller declaration, deterministic
   add/replace/delete operations, expected SHA-256, proposed bump, replay key,
   structured learning evidence/validation/context/tags/extra metadata, policy
   decision, candidate, review, and publication results.
2. Added context mutation schemas for immutable knowledge revisions and note
   create/update semantics with selected skill/context, expected revision,
   bounded Markdown and metadata, replay key, and exact revision output.
3. Registered `skill_amend`, `context_knowledge_update`, and
   `context_note_upsert` beside the six existing MCP read tools.
4. Extended request preflight to require `skills:amend` or `contexts:write`
   before tool execution while preserving standards-compliant challenges.
5. Reused the production amendment/context domain services rather than
   implementing MCP-only policy or revision behavior.
6. Added typed MCP mutation audit context and inserted successful audit inside
   the same transaction as candidate/revision and idempotency completion.
7. Preserved authenticated credential/principal separately from complete
   caller-declared agent/model/client/run/session/conversation metadata.
8. Added migration `0013_organization_agent_attribution.sql` so organization
   service principals retain paired agent/model attribution without requiring
   a fabricated user.
9. Extended note revision records with current base revision and creation time
   so MCP returns exact immutable revision identity.
10. Added stable mutation/conflict/idempotency/bundle/R2 error codes and safe,
    bounded conflict details.
11. Added same-selected-context ownership verification before note update.
12. Added focused schema, integration, security, concurrency, OAuth/service
    attribution, policy, audit rollback, protocol, and end-to-end coverage.
13. Added root logical `mcp-mutations` integration/security suites and the
    `test:mcp:e2e` command.

## Tool contracts

| Tool | Required scope | Semantics |
|---|---|---|
| `skill_amend` | `skills:amend` | exact-base, digest-checked immutable candidate; explicit review/auto-publish decision |
| `context_knowledge_update` | `contexts:write` | optimistic immutable next shared-knowledge revision |
| `context_note_upsert` | `contexts:write` | create revision 1 or update from required expected revision |

All three advertise:

```text
readOnlyHint=false
destructiveHint=false
idempotentHint=true
openWorldHint=false
```

## Idempotency and concurrency

- Exact retries return the original candidate, knowledge revision, or note
  revision.
- Reusing a key with changed normalized input returns
  `IDEMPOTENCY_KEY_REUSED`.
- Stale skill bases return `SKILL_VERSION_CONFLICT`.
- Stale context knowledge returns `CONTEXT_REVISION_CONFLICT` with current
  revision metadata.
- Two note writers based on revision 1 produce exactly revision 2 plus one
  `NOTE_REVISION_CONFLICT`; last-write-wins is impossible.

## Audit invariants

- Candidate/revision, audit, and idempotency completion share one Postgres
  transaction.
- A forced audit insert failure returns `AUDIT_WRITE_FAILED` and rolls back the
  mutation.
- Failed amendment R2 uploads/candidates are cleaned when unreferenced.
- Service and OAuth authenticated identities are server-derived.
- Caller-declared agent/model fields are stored with an explicit trust label.
- Mutation audit metadata contains no skill/context body, token, SQL, or
  provider error.

## Verification

```text
pnpm test:unit --filter @skillplane/mcp-schema -- amend contexts
PASS — 2 files, 20 tests

pnpm test:integration --filter mcp-mutations
PASS — 1 file, 5 tests

pnpm test:security --filter mcp-mutations
PASS — 1 file, 6 tests

pnpm test:mcp:conformance
PASS — 1 file, 5 tests

pnpm test:mcp:e2e
PASS — 1 file, 5 tests

pnpm typecheck
PASS — 27/27 tasks

pnpm lint
PASS

pnpm format:check
PASS

pnpm db:migrate
PASS — migration 0013 applied

pnpm db:verify
PASS — 28 tables and 13 migrations

focused app/MCP read regression sweep
PASS — 28 tests
```

## Evidence

- Completion report:
  `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_12-2026-07-26-af083f59-report.md`
- Verification: `.conduct/evidence/phase-12/verification.md`
- Decision:
  `.conduct/decisions/DECISION-0005-mcp-mutation-transactions-and-attribution.md`
- Observations:
  `.conduct/observations/2026-07-26-phase-12-mcp-mutations.md`

## External boundaries

No Superfunctions worktree or source file was modified. PHASE_13 analytics,
aggregation, retention, and analytics UI were not started.
