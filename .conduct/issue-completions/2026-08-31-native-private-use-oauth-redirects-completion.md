# Native private-use OAuth redirect compatibility

## Metadata

- Timestamp: `2026-08-31T07:29:59Z`
- Agent: Codex `/root`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: repository root
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `main`
- Base commit: `965ceb0a1f76ee3589510cff2506412a0f0d1069`
- Issue: Cursor and Grok registration bundles are rejected when they contain the non-RFC `cursor:` callback alongside valid HTTPS and loopback callbacks
- Deployment state: no Skillplane development or production deployment was performed

## Issue summary

Skillplane correctly delegated OAuth redirect validation to McpFn, but the available McpFn policy supported loopback HTTP and RFC 8252 reverse-domain native schemes only. Cursor-family clients submit their complete callback bundle during dynamic client registration, including a non-reverse-domain `cursor:` callback even when a standards-compliant callback will be selected later. The registration endpoint therefore rejected the complete metadata document before authorization could begin.

## Status

PASS — McpFn now exposes an opt-in, host-allowlisted compatibility policy; Skillplane enables it only for the `cursor` scheme; the published package is installed from npm; and the full Cursor registration set reaches persistence with redacted audit evidence. User-run Grok verification against the restarted local servers remains intentionally pending.

## Requirements summary

### Keep the secure policy as the default

- Status: PASS
- Evidence: McpFn retains explicit `disabled` and RFC 8252 modes. Compatibility is opt-in and requires a host-provided positive scheme list.
- Security boundaries: non-loopback HTTP, credentials, fragments, wildcards, opaque callbacks, browser/launcher/network schemes, and malformed URLs remain rejected.

### Accept the affected native-client registration bundle

- Status: PASS
- Evidence: Skillplane configures `privateUseSchemePolicy: "compatible"` with `compatiblePrivateUseSchemes: ["cursor"]`; a route-level regression posts Cursor's complete `cursor:`, HTTPS, and localhost callback set to `/oauth/register`, receives HTTP 201, and verifies exact persistence.
- Matching boundary: authorization still requires exact registered redirect matching; dynamic-port relaxation remains loopback-only; PKCE S256 and public-client handling are unchanged.

### Preserve privacy-safe operational evidence

- Status: PASS
- Evidence: successful dynamic registration emits only the compatibility policy, accepted scheme name, and count. Callback hosts, paths, query data, and full redirect URIs are not forwarded to Skillplane audit events.
- Test status: the regression explicitly asserts that the Cursor callback host and localhost port are absent from serialized events.

### Consume a released upstream artifact

- Status: PASS
- Evidence: upstream PR `21nCo/super-functions#136` merged to `dev` at `ff93a4b91529a4c9c98fb18d43d7ef0e7df4b613`; tag `mcpfn-auth-v0.0.4` published `@mcpfn/auth@0.0.4`; Skillplane's lockfile records registry integrity `sha512-9vwa47X+y/vWroY/tW/ankdBgehqP6zvk6ncBdHAPtf/PGWQuKK+94n/BQnmrx0Adk4Ju4nRBP5RUDWzOtHqjQ==` with no local link.

## Implementation summary

### Upstream McpFn

- Added `disabled`, `rfc8252`, and `compatible` private-use redirect policies.
- Required a positive host scheme allowlist in compatible mode and retained a hard unsafe-protocol denylist as defense in depth.
- Preserved the deprecated boolean option with defined migration behavior.
- Added redacted successful-registration diagnostics and exact Cursor/Grok compatibility regressions.
- Verified 62 focused auth tests, the full McpFn release gate, package packing, ESM/CommonJS consumption, Node 18 CommonJS, and registry publication.

### Skillplane files changed or added

- `mcp/package.json`
- `packages/auth/src/server.ts`
- `packages/authfn-mcp-oauth/package.json`
- `packages/authfn-mcp-oauth/src/oauth.test.ts`
- `packages/authfn-mcp-oauth/src/plugin.ts`
- `packages/authfn-mcp-oauth/src/redirect-policy.ts`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `.conduct/issue-completions/2026-08-31-native-private-use-oauth-redirects-completion.md`
- `.conduct/logs.csv`
- `.conduct/tracker.csv`

## Verification summary

### Passing checks

- `pnpm install --frozen-lockfile` — PASS with pnpm 11.9.0 and the published registry artifact.
- `pnpm --filter @skillplane/authfn-mcp-oauth typecheck` — PASS.
- `pnpm --filter @skillplane/authfn-mcp-oauth test:unit` — PASS, 18 tests.
- `pnpm --filter @skillplane/auth typecheck` — PASS.
- `pnpm --filter @skillplane/auth test:unit` — PASS, 7 tests.
- `pnpm --filter @skillplane/mcp typecheck` — PASS.
- `pnpm --filter @skillplane/mcp test:unit` — PASS, 19 tests.
- `pnpm --filter @skillplane/mcp build` — PASS.
- `pnpm --filter @skillplane/mcp deploy:check` — PASS.
- `pnpm mcpfn:verify` — PASS for `@mcpfn/auth@0.0.4`, `@mcpfn/core@0.0.4`, and `@mcpfn/testing@0.0.4`.
- `pnpm test:security --filter oauth` — PASS, 17 tests.
- `pnpm test:integration --filter oauth` — PASS, 8 tests.
- changed-surface ESLint and Prettier checks — PASS after tightening the audit metadata type guard.
- `git diff --check` — PASS.
- `pnpm conduct:verify` — conduct structure and append-only checks passed before the portability subprocess reported the existing ignored `.data/cloudflared.yml`, `docs/.next`, and `docs/.open-next` local runtime/build paths.

### Upstream CI exception

- The McpFn release gate and Node 18 CommonJS job passed on the exact PR head.
- The broad monorepo JavaScript job failed in the unrelated `@uifn/examples` graph because `@uifn/components` could not be resolved. No UI package was changed to mask that pre-existing build-order failure.

### Manual verification

- Restart `app-local`, `mcp-local`, and the existing named Cloudflare tunnel after committing the local Skillplane change.
- The user will retry the Grok connector end to end. This report does not claim that model-in-loop result.

## Notes

- Compatibility is deliberately constrained to `cursor:` rather than a URL-by-URL callback allowlist or an open custom-scheme fallback.
- The captured Cursor payload is exact. The Grok regression is based on the observed Cursor-family callback bundle; a live Grok DCR payload has not yet been captured.
- The conduct portability result is unrelated generated local state; none of the reported files is tracked or part of this changeset.
- The local `main` commit remains unpushed until the user completes manual verification.
- No production configuration, database schema, secret, or deployed Worker was changed.

## Blockers

None for the local implementation and automated verification.
