# PHASE_00 — Repository, evidence, and dependency baseline

## Phase goal

Establish the real Skillplane repository, append-only evidence system, and safe external dependency contract before production code changes.

## In scope

- Initialize Git at the repository root.
- Preserve and validate the existing `.conduct` bundle.
- Record Superfunctions `dev`, Superfunctions `next`, and Nucleus dependency revisions and status.
- Implement a preflight that checks Node, pnpm, Docker engine, port, external worktrees, and required source paths.
- Define environment-variable names without committing values.

## Out of scope

- Application packages.
- Database container creation.
- Superfunctions edits.
- Cloudflare resource creation.

## Deliverables

- `.gitignore`
- `.editorconfig`
- `.npmrc`
- `scripts/preflight.mjs`
- `.conduct/dependency-baseline.json`
- `.conduct/decisions/DECISION-0002-external-superfunctions.md`
- `.conduct/logs/engineering/PHASE_00.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_00.md`
- appended `.conduct/ledger.md`

## Requirements covered

- `PROJ-003`
- `PROJ-004`
- `OPS-001`
- `OPS-004`
- `QA-004`

## Implementation tasks

1. Initialize Git without adding or committing unrelated parent-folder content.
2. Add ignores for dependencies, build output, Wrangler state, environment secrets, database volumes, Playwright output, and generated deployment configuration.
3. Implement `scripts/preflight.mjs` with explicit exit codes for:
   - unsupported Node/pnpm;
   - Docker engine unavailable;
   - configured Postgres port occupied;
   - missing Superfunctions worktrees;
   - overlapping dirty SendFn paths;
   - missing AuthFn/DataFn/SendFn source packages.
4. Store only sanitized worktree label, branch, commit, dirty boolean, and changed relative paths in `.conduct/dependency-baseline.json`.
5. Record the accepted mixed-worktree dependency decision and production pinning rule.
6. Run all checks and append evidence.

## Verification steps

```bash
git status --short --branch
node scripts/preflight.mjs --mode spec-safe
node scripts/preflight.mjs --check-portability
```

Expected outcomes:

- Git reports only repository-local files.
- Preflight reports dependency revisions and identifies pre-existing dirty SendFn paths without modifying them.
- Port and Docker checks are explicit.
- Portability scan returns no machine-specific committed paths.

## Stop condition

Report the dependency baseline, dirty external paths, and preflight results before starting `PHASE_01`.
