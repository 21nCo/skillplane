# SKI-14 immediate OAuth compatibility remediation

## Metadata

- Timestamp: `2026-08-30T11:12:02Z`
- Agent: Codex `/root`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Issue: Linear `SKI-14` — Adapt Skillplane tool contracts for authenticated client compatibility
- Git branch: `codex/ski-14-oauth-hotfix`
- Base commit: `c0e8d488fe73bf036000f96b4dab06d029746cb2`
- Initial worktree status: clean isolated worktree at the live `origin/main` head
- Environment: `Darwin arm64`, shell `zsh`
- Deployment state: no development or production deployment was performed

## Status

PARTIAL — the bounded immediate Skillplane compatibility remediation is implemented and locally verified. Full `SKI-14` remains open for McpFn structured diagnostics, final cross-tool workspace-selector normalization, controlled model-in-loop verification, and an explicitly authorized production rollout.

## Root cause

Skillplane's canonical strict tool schemas require a ten-field `caller` object, but only the Linear OAuth client received a projected catalog without that server-owned field and a matching pre-validation enrichment step. Other authenticated OAuth clients therefore saw `caller` as model-owned. The affected listing attempt also used a flat `workspaceId` while canonical `skills_list` requires a nested `workspace` selector. McpFn correctly rejected the resulting root shape before the handler, while its current error formatter omitted AJV's exact additional-property detail.

## Immediate remediation requirements

### Hide and inject caller for authenticated OAuth clients

- Status: PASS
- Evidence: every authenticated OAuth identity receives a catalog projection without `caller`; call preparation always overwrites model-supplied caller data with bounded values selected from verified Claude, Linear, or generic OAuth profiles before McpFn validation.
- Boundary: service principals retain the canonical caller-visible and caller-required contract.

### Preserve strict schema enforcement

- Status: PASS
- Evidence: projected input schemas retain `additionalProperties: false`; ambiguous duplicate selectors and the malformed `workspace_id` property are not normalized and remain rejected.
- Boundary: no McpFn strictness was relaxed and no arbitrary additional properties are accepted.

### Restore the affected skills-listing journey

- Status: PASS
- Evidence: an authenticated OAuth regression uses the original flat `workspaceId` listing shape without caller metadata, executes through the production call-preparation function, reaches `skills_list`, and returns the seeded workspace and skill list.
- Compatibility rule: only an unambiguous string `workspaceId` on `skills_list` is translated to canonical `workspace: { id }` before validation.

### Preserve existing client behavior

- Status: PASS
- Evidence: Linear catalog compaction remains below its 32 KiB budget, while Claude and generic OAuth retain normal presentation and output metadata. Service-principal catalog and call behavior remain canonical.

## Implementation summary

### Files changed or added

- `mcp/src/index.ts`
- `mcp/src/server.ts`
- `mcp/tests/conformance/mcp.conformance.test.ts`
- `.conduct/issue-completions/2026-08-30-9f2c1a7b-completion.md`
- `.conduct/logs.csv`
- `.conduct/tracker.csv`

### Key changes

- Replaced the one-off Linear call preparer with an authenticated OAuth client-profile resolver covering Claude, Linear, and generic OAuth clients.
- Projected caller out of every OAuth model-visible tool schema and removed an empty `required` array when caller was the only canonical required property.
- Overwrote forged OAuth caller arguments with bounded server-derived attribution before strict validation.
- Added the narrow `skills_list.workspaceId` compatibility translation while retaining canonical nested workspace validation and strict rejection of ambiguity.
- Kept Linear-only catalog-size compaction separate from the common OAuth caller projection.
- Updated server instructions to distinguish client-declared service-principal caller data from OAuth profile-derived caller attribution.
- Removed the hard Linear `MCP-3 blocks SKI-14` relationship and documented the staged dependency in the issue and architecture document. MCP-3 is still required before replacing the local lifecycle or completing structured diagnostics.

## Verification

### Final passing checks

- `pnpm --filter @skillplane/mcp typecheck` — PASS.
- `pnpm --filter @skillplane/mcp test:unit` — PASS, 19 tests.
- changed-surface ESLint — PASS.
- changed-surface Prettier — PASS.
- `pnpm test:mcp:contract` with the configured local test database — PASS, including the complete MCP dependency build, Worker dry-run bundle, and 12 contract tests.
- focused MCP conformance regression rerun — PASS, 12 tests.
- `pnpm --filter @skillplane/mcp test:security` — PASS, 27 tests.
- `git diff --check` — PASS.
- `pnpm conduct:verify` — repository structure, log shape, and append-only checks passed before its portability subprocess reported the isolated worktree's `.git` pointer as a machine-specific path.

### Regression coverage

- Claude catalog caller projection and caller construction.
- Linear catalog budget, caller projection, and caller construction.
- Generic authenticated OAuth catalog projection and caller construction.
- Service-principal canonical catalog and unchanged call preparation.
- Forged OAuth caller overwrite.
- Original flat `workspaceId` OAuth listing call reaching the handler and returning skills.
- Ambiguous `workspace` plus `workspaceId` preservation for strict rejection.
- Malformed `workspace_id` negative call remaining rejected.

### Environment notes

- The isolated worktree did not contain the ignored `.data/local-runtime.json`, so the first contract attempt stopped before assertions.
- The existing main-checkout local runtime was supplied to the test process without printing credentials. Its Postgres container was started through the repository's `db:up` command, after which the contract and security suites passed.
- The repository requires Node 22 and pnpm 11.9.0; verification used the installed Node 22 runtime and Corepack-pinned pnpm 11.9.0.
- The portability report is a worktree-only false positive: `.git` is a Git-managed file containing the main repository path in linked worktrees, while the checker excludes `.git` only when it is a directory. The changed repository files contain no machine-specific paths.

## Remaining SKI-14 work

- Preserve AJV `additionalProperty` and `missingProperty` details through McpFn and add safe pre-handler diagnostic events.
- Complete the reviewed workspace-selector convention across discovery tools rather than extending the narrow listing compatibility rule.
- Run the controlled deployed target-family model canary and production smoke checks after explicit deployment authorization.
- Replace the local profile lifecycle with the reusable McpFn contract from `MCP-3` when available.

## Blockers

None for the immediate local remediation. Production deployment and model-in-loop verification were not authorized in this run.
