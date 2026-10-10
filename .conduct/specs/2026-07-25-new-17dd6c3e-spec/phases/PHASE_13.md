# PHASE_13 — Audit retention, analytics, and product views

## Phase goal

Deliver trustworthy retrieval/mutation analytics, permanent security history, retention, dashboards, and redacted audit exploration.

## In scope

- Audit event writers/readers.
- Detailed retrieval retention.
- Idempotent daily aggregation.
- Workspace and skill analytics.
- Audit explorer, filtering, and export.
- Caller-declared metadata labels.

## Out of scope

- Third-party analytics warehouse.
- Raw prompt or skill-content analytics.

## Deliverables

- `packages/observability/src/audit.ts`
- `packages/observability/src/redaction.ts`
- `packages/observability/src/retrieval.ts`
- `packages/observability/src/retention.ts`
- `packages/observability/src/rollups.ts`
- `packages/observability/src/metrics.ts`
- `packages/api/src/routes/audit.ts`
- `packages/api/src/routes/analytics.ts`
- `scripts/audit-retention.mjs`
- `scripts/analytics-rollup.mjs`
- `app/src/routes/(app)/[workspaceSlug]/analytics/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/audit/+page.svelte`
- skill analytics/audit tab pages
- `app/src/lib/analytics/*`
- `app/src/lib/audit/*`
- retention/rollup/redaction/API/UI tests and screenshots
- engineering log, phase report, and ledger append

## Requirements covered

- `AUD-001`
- `AUD-002`
- `AUD-003`
- `AUD-004`
- `AUTH-008`
- `UI-002`
- `UI-004`
- `UI-005`
- `OPS-005`
- `QA-001`
- `QA-002`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Centralize permanent and detailed audit schemas, writers, and redaction.
2. Ensure private retrieval audit is durable before content response.
3. Implement 90-day detailed retention with permanent event exclusion.
4. Implement restartable, idempotent UTC daily rollups.
5. Calculate counts, unique dimensions, adoption, failures, and latency percentiles.
6. Build tenant/role-safe analytics APIs with bounded filters.
7. Build dashboard and audit explorer with exact declared-metadata labels.
8. Implement redacted current-filter export.
9. Test event/aggregate consistency before and after retention.
10. Test that prompts, bodies, OTPs, emails, tokens, and secrets never enter durable analytics/logs.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/observability
pnpm test:integration --filter audit-analytics
pnpm test:security --filter redaction
pnpm test:e2e --grep @analytics
pnpm test:e2e --grep @audit
pnpm test:visual --filter analytics-audit
```

Expected outcomes:

- Audit fail-closed semantics hold.
- Rollups are idempotent.
- Retention removes only eligible detail.
- Viewer cannot access detailed audit.
- UI totals match database fixtures and label declared values.

## Stop condition

Report retention counts, rollup replay proof, redaction scan, API authorization, and dashboard screenshots before `PHASE_14`.
