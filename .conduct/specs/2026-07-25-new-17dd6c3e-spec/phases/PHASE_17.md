# PHASE_17 — Final acceptance and operational handoff

## Phase goal

Prove every intent item and requirement is complete, reconcile all evidence, and hand off an operable production system.

## In scope

- Full root verification.
- Requirement/test-vector traceability.
- Production critical-path manual verification.
- Documentation and runbook review.
- Final conduct audit and tracker completion.

## Out of scope

- New features.
- Waiving failed release gates.

## Deliverables

- updated `INTENT_AUDIT.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_17.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/COMPLETION.md`
- final `.conduct/ledger.md` entry
- final global/spec log rows
- updated `.conduct/tracker.csv` entry
- `docs/operations/index.md`
- sanitized production evidence index

## Requirements covered

- All requirements
- `QA-004` specifically governs completion

## Implementation tasks

1. Run every global verification command from `PLAN.md`.
2. Map every requirement to implementation files, automated tests, and manual evidence where required.
3. Execute a production critical path:
   - email OTP sign-in;
   - create organization and invitation;
   - create and publish a skill;
   - create context knowledge and note;
   - complete OAuth consent from an MCP client;
   - search and retrieve the contextual skill;
   - amend through MCP;
   - review and publish in the app;
   - verify version, audit, and analytics;
   - open the public skill page.
4. Verify backup, restore, retention, and rollback runbooks are executable.
5. Scan all committed artifacts for secrets, machine-specific paths, placeholders, stubs, and unsupported claims.
6. Update the intent audit to current implementation evidence.
7. Mark the tracker complete only if no required work remains.

## Verification steps

```bash
pnpm install --frozen-lockfile
pnpm conduct:verify
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm test:security
pnpm test:a11y
pnpm test:e2e
pnpm build
pnpm deploy:check
pnpm smoke:production
```

Expected outcomes:

- Every command exits `0`.
- Intent audit states `No missing intent items`.
- Production critical path succeeds with matching durable state and audit.
- No placeholder/stub/secret/path scan finding remains.
- Tracker is completed with `COMPLETION.md`.

## Stop condition

Return the final evidence-backed completion summary, production URLs, verification results, known operational limits, and recovery entrypoints; do not claim completion if any gate is missing or failed.
