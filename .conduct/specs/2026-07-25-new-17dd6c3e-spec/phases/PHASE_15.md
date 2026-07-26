# PHASE_15 — Security, accessibility, performance, and reliability hardening

## Phase goal

Prove the complete local product meets production security, accessibility, performance, failure, and recovery requirements.

## In scope

- Full security attack matrix.
- WCAG 2.2 AA matrix.
- Load and query-plan gates.
- Failure injection.
- Backup/restore and orphan cleanup rehearsal.
- Dependency and production-bundle audits.

## Out of scope

- Production resource provisioning.
- New features.

## Deliverables

- `tests/security/*`
- `tests/performance/*`
- `tests/accessibility/*`
- `tests/recovery/*`
- `scripts/security-scan.mjs`
- `scripts/performance-gate.mjs`
- `scripts/backup.mjs`
- `scripts/restore.mjs`
- `scripts/orphan-cleanup.mjs`
- `docs/operations/local-recovery.md`
- decision records for any hardening semantic change
- engineering log, evidence artifacts, screenshots, phase report, and ledger append

## Requirements covered

- `AUTH-003`
- `AUTH-004`
- `AUTH-006`
- `SKL-003`
- `MCP-008`
- `AUD-002`
- `UI-004`
- `OPS-004`
- `OPS-005`
- `OPS-006`
- `QA-001`
- `QA-002`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Run tenant isolation across web, API, DataFn, R2, and MCP selectors.
2. Run OAuth redirect, PKCE, code replay, token replay, resource confusion, refresh reuse, consent, and registration attacks.
3. Run bundle traversal, duplicate, symlink, bomb, Unicode, Markdown, and signed-download attacks.
4. Run CSRF, OTP abuse, Turnstile, credential leakage, and audit redaction tests.
5. Run keyboard, screen-reader smoke, reduced-motion, contrast, dialog, error, and viewport matrix.
6. Load test search, skill retrieval, audit write, and analytics endpoints against the scale fixture.
7. Validate indexes and caching headers.
8. Inject Postgres, R2, Email, and audit failures and verify specified behavior.
9. Rehearse database backup/restore, R2 inventory, and orphan cleanup.
10. Scan production bundles for test fixtures and secrets.

## Verification steps

```bash
pnpm test:security
pnpm test:a11y
pnpm test:performance
pnpm test:recovery
pnpm test:e2e
pnpm build
pnpm security:scan
pnpm deploy:check
```

Expected outcomes:

- No release-blocking security or accessibility failure remains.
- p95 targets and query-plan gates pass.
- Failure behavior matches stable errors and fail-closed rules.
- Restore reproduces all referenced skill versions.
- Production bundles contain no fixtures or secrets.

## Stop condition

Report full matrices, performance percentiles, query plans, recovery inventory, and unresolved risks before `PHASE_16`.
