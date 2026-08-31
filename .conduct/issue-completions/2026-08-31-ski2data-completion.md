# Issue completion: adopt DataFn for first-party skill reads

## Metadata

- Timestamp: `2026-08-31T14:31:36Z`
- Agent: `unknown-agent`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: repo root
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `SKI-2`
- Base commit: `861684a8e6882b5f8619001a24034b107bd0086c`
- Implementation commit: `f6270fc5cb0df8f5a0dc392d397f46dd3936eb73`
- Initial worktree status: clean
- Issue: `2026-08-03-dhu1z1rz-issue`

## Issue summary

The first-party application previously bypassed its authenticated, tenant-filtered DataFn service entirely. This implementation establishes an explicit ownership matrix, moves the approved authenticated skill and version reads to the typed DataFn client over the canonical gateway, and keeps invariant-heavy commands and composite R2 reads on Hono domain services.

## Status

PASS

## Requirements summary

### Production DataFn consumer

- Status: PASS
- Evidence: the SvelteKit app depends on `@skillplane/datafn`, creates the shared client through `@skillplane/datafn/client`, and sends skill list, detail, and version metadata reads to `/datafn/query` with the selected workspace header and AuthFn credentials.
- Boundary: client workspace input requests a namespace but does not grant access; the gateway and regional server still authenticate and authorize the workspace before mandatory row-level filtering.

### Data-operation ownership

- Status: PASS
- Evidence: `docs/operations/data-operation-ownership.md` records approved DataFn reads, retained Hono reads, an empty generic DataFn mutation set, and the future direct-regional transport boundary.
- Command safety: skill create, amend, publish, archive/restore, bundle, file, and diff workflows continue through domain commands so R2, idempotency, concurrency, audit, and compensation invariants are preserved.

### Schema and transport parity

- Status: PASS
- Evidence: the DataFn schema now includes current-version relation expansion and the complete first-party skill-version metadata contract. Cursor, filter, search, sort, error, and date serialization behavior have focused unit and PostgreSQL integration coverage.
- Upstream defect: DataFn 0.1.1 reduced `Date` objects to `{}` while recursively applying relation FK omissions. Skillplane carries a narrow read-serialization compatibility adapter; the reusable fix is isolated in Superfunctions PR `#139` and can replace the adapter after publication.

## Verification summary

- Focused ESLint and Prettier checks: PASS for every changed source and test file.
- DataFn unit tests: PASS, 6 tests.
- DataFn PostgreSQL integration: PASS, 3 tests with real AuthFn sessions and tenant isolation.
- App unit tests: PASS, 16 tests, including 3 real DataFn HTTP-client contract tests.
- API unit tests: PASS, 56 tests.
- Root unit graph: PASS, 31 of 31 tasks.
- App and testing typechecks: PASS; Svelte reported zero errors and warnings.
- Dependency-closed app production build: PASS, 14 of 14 tasks.
- Skills Playwright suite: PASS, 2 of 2 scenarios; network assertions prove skill reads use `/datafn/query` while command workflows remain operational.
- Upstream DataFn server: PASS, 94 files; 1,025 tests passed and 1 skipped. Typecheck and dependency-closed build passed.

## Notes

- Repository-wide lint still reports the pre-existing unresolved generated `collections/server` docs module through type-aware rules. All changed files pass focused lint, and the same missing generated module is the only known root typecheck blocker.
- The browser flow used the repository's isolated local fixture identity; no Aside Browser profile or personal identity was used.

## Blockers

None.
