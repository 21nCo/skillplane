# Issue completion: Codex loopback client metadata authorization

## Metadata

- Timestamp: `2026-08-30T04:27:43Z`
- Agent: `unknown-agent`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: repo root
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `codex/oauth-loopback-metadata`
- Base commit: `f1869455670f709534c6c6a659cb0ae265319c01`
- Initial worktree status: dirty with four intended OAuth source/test changes
- Issue description: Codex authorization fails with `invalid_client_metadata` because its Client ID Metadata Document includes a localhost fallback and its runtime callback uses a dynamic IPv4 loopback port.

## Issue summary

Skillplane delegated redirect validation to McpFn without opting into localhost loopback redirects. Codex publishes both portless `127.0.0.1` and `localhost` callback variants, so McpFn rejected the complete client metadata document before matching the valid runtime callback. Skillplane's client registry also normalized persisted clients without the route-level redirect policy.

## Status

PASS

## Requirements summary

### Accept the Codex Client ID Metadata Document

- Status: PASS
- Evidence: the OAuth unit fixture supplies Codex's HTTPS metadata-document client ID, portless IPv4 loopback redirect, localhost fallback, native application metadata, and public-client authentication method.
- Test status: `pnpm --filter @skillplane/authfn-mcp-oauth test:unit` passed 17 of 17 tests.

### Match a runtime-selected IPv4 loopback port safely

- Status: PASS
- Evidence: the regression requests a port-bearing `127.0.0.1` callback with the exact registered path and verifies that authorization reaches the sign-in redirect and stores the requested URI as a loopback redirect.
- Test status: focused OAuth unit, integration, and browser E2E suites passed.

### Apply one policy across authorization and client persistence

- Status: PASS
- Evidence: `SKILLPLANE_MCP_REDIRECT_POLICY` is passed to the compatibility handler, stored-client resolution, and dynamic-client registration normalization.
- Test status: the browser OAuth flow dynamically registered a localhost client with HTTP 201, completed authorization and consent, and reached the callback.

### Preserve strict handling for non-loopback insecure redirects

- Status: PASS
- Evidence: only McpFn's localhost and dynamic-loopback-port policy flags are enabled; non-loopback HTTP handling is unchanged.
- Test status: `pnpm test:security --filter oauth` passed 17 of 17 tests, including unsafe redirect rejection.

## Implementation summary

### Files changed or added

- `packages/authfn-mcp-oauth/src/redirect-policy.ts`
- `packages/authfn-mcp-oauth/src/plugin.ts`
- `packages/authfn-mcp-oauth/src/clients.ts`
- `packages/authfn-mcp-oauth/src/oauth.test.ts`
- `.conduct/issue-completions/2026-08-30-33cfc7a1-completion.md`
- `.conduct/logs.csv`
- `.conduct/tracker.csv`

### Key changes

- Added one internal, typed Skillplane redirect policy that opts into localhost loopback redirects and runtime-selected loopback ports.
- Applied that policy to McpFn's hosted compatibility handler and both Skillplane client-registry normalization paths.
- Added a route-level regression based on Codex's real client metadata shape without retaining the user's ephemeral client identifier.

## Verification summary

### Verification steps executed

- `pnpm --filter @skillplane/authfn-mcp-oauth test:unit` — PASS, 17 tests.
- `pnpm --filter @skillplane/authfn-mcp-oauth typecheck` — PASS.
- `pnpm exec eslint packages/authfn-mcp-oauth/src/plugin.ts packages/authfn-mcp-oauth/src/clients.ts packages/authfn-mcp-oauth/src/redirect-policy.ts packages/authfn-mcp-oauth/src/oauth.test.ts` — PASS.
- `pnpm exec prettier --check packages/authfn-mcp-oauth/src/plugin.ts packages/authfn-mcp-oauth/src/clients.ts packages/authfn-mcp-oauth/src/redirect-policy.ts packages/authfn-mcp-oauth/src/oauth.test.ts` — PASS.
- `pnpm test:security --filter oauth` — PASS, 17 tests.
- `pnpm test:integration --filter oauth` — PASS, 8 tests.
- `pnpm test:e2e packages/testing/e2e/oauth-consent.spec.ts` — PASS, 1 browser test.
- `pnpm mcpfn:verify` — PASS for `@mcpfn/auth@0.0.3`, `@mcpfn/core@0.0.4`, and `@mcpfn/testing@0.0.4`.
- `pnpm test:mcp:contract` — PASS, 8 tests.
- `pnpm test:mcp:conformance` — PASS, 1 official conformance test.
- `pnpm test:mcp:e2e` — PASS, 6 tests.
- `TURBO_FORCE=true pnpm build` — PASS, 16 of 16 tasks with zero cached tasks.
- `TURBO_FORCE=true pnpm typecheck` — PASS, 29 of 29 tasks with zero cached tasks.
- `TURBO_FORCE=true pnpm test:unit` — PASS, 28 of 28 tasks with zero cached tasks; root script tests also passed 62 of 62.
- `git diff --check` — PASS.

### Test execution results

- OAuth package unit: 17 passed, 0 failed.
- OAuth security: 17 passed, 0 failed.
- OAuth integration: 8 passed, 0 failed.
- OAuth browser E2E: 1 passed, 0 failed.
- MCP contract/conformance/E2E: 15 passed, 0 failed.
- Repository build/typecheck/unit task graphs: 73 successful tasks, 0 failed, 0 cached.

### Manual verification

The browser harness observed successful dynamic client registration, authorization request validation, consent grant, and loopback callback navigation. No development or production environment was changed.

## Notes

- The first browser attempt lacked the generated SvelteKit tsconfig in the fresh worktree; `pnpm --filter @skillplane/app sync` supplied the standard prerequisite.
- The next browser attempt revealed that Skillplane's dynamic client adapter re-normalized metadata without the route policy; centralizing the policy resolved both metadata-document and dynamic-registration paths.
- Generated browser screenshots were restored to the exact base versions and are not part of this changeset.
- No public API, dependency, database migration, environment configuration, or deployment was changed.

## Blockers

None.
