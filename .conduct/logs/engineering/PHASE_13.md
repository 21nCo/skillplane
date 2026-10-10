# PHASE_13 engineering log

- Started: `2026-07-26T12:53:31Z`
- Completed: `2026-07-26T13:54:06Z`
- Status: `COMPLETE — PASS`
- Scope: audit centralization and redaction, permanent/detailed retention,
  idempotent daily rollups, tenant-safe analytics and audit APIs, dashboard,
  explorer/export, operational jobs, and UI/test evidence.

## Implemented

1. Added `@skillplane/observability` with central audit writing/reading,
   recursive bounded redaction, retrieval audit, restartable retention,
   idempotent UTC rollups, and permanent analytics reads.
2. Replaced direct application/domain/OAuth/MCP audit inserts with the central
   writer and explicit retention classes.
3. Added migrations for audit retention class, immutable/guarded deletion,
   insert-time redaction defense, analytic summaries/dimensions/run records,
   and audit/analytics query indexes.
4. Added rollup-before-delete retention with advisory locking,
   `FOR UPDATE SKIP LOCKED` batches, permanent completion audit, and a dry-run
   mode.
5. Added daily workspace/skill counts for retrievals, amendments, approvals,
   context writes, failures, unique principals, declared agents/models,
   latency p50/p95, current-version adoption, and dimensions.
6. Added bounded workspace and skill analytics APIs available to workspace
   members and detailed audit list/export APIs restricted to `audit:read`.
7. Added signed opaque audit pagination with time, skill, context, tool,
   outcome, declared-agent, and declared-model filters.
8. Added workspace and skill Analytics/Audit pages, navigation, responsive
   dashboards, filter/export controls, trust labels, and all non-happy states.
9. Hardened operational output: no arbitrary API error message, no arbitrary
   DataFn logger context, and redacted OAuth runtime metadata.
10. Added root rollup/retention commands, database verification, focused
    unit/integration/security tests, real-service Playwright workflows, Axe
    checks, and four visual goldens.

## Retention model

| Class | Content | Deletion |
|---|---|---|
| `detailed_read_90d` | attributable private retrieval detail | eligible only after 90 days and only inside guarded retention job |
| `permanent` | mutation, publication, membership, authorization, OAuth security, retention execution | database-enforced immutable |
| daily rollups | counts, dimensions, adoption, failures, latency | permanent aggregate tables |

## Identity and redaction invariants

- Actor, optional user, and credential are server-derived/authenticated.
- Agent, model, client, run, session, and conversation remain explicitly
  caller-declared.
- Audit and export contain IDs, digests, outcomes, bounded diagnostics, and
  latency—not returned content.
- Prompt, body/content, instructions, OTP, email, token, authorization,
  cookie, password, and secret keys are removed.
- Email-like and bearer/service-credential-like values are rejected.
- Postgres provides a second enforcement boundary for direct inserts.

## Verification

```text
pnpm test:unit --filter @skillplane/observability
PASS — 2 files, 3 tests

pnpm test:integration --filter audit-analytics
PASS — 1 file, 2 tests

pnpm test:security --filter redaction
PASS — 1 file, 2 tests

pnpm test:e2e --grep @analytics
PASS — 3 tests

pnpm test:e2e --grep @audit
PASS — 1 test

pnpm test:visual --filter analytics-audit
PASS — 1 test, 4 goldens

pnpm typecheck
PASS — 29/29 tasks

pnpm lint
PASS

pnpm format:check
PASS

pnpm build
PASS — 16/16 packages

pnpm db:verify
PASS — 31 tables, 15 migrations
```

## Evidence

- Completion report:
  `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_13-2026-07-26-520f647b-report.md`
- Verification: `.conduct/evidence/phase-13/verification.md`
- Decision:
  `.conduct/decisions/DECISION-0006-audit-retention-and-rollups.md`
- Observations:
  `.conduct/observations/2026-07-26-phase-13-audit-analytics.md`
- Screenshots: `.conduct/screenshots/phase-13/`

## External boundaries

No Superfunctions worktree or source file was modified. PHASE_14 landing and
public discovery work was not started.
