# McpFn runtime adoption completion

## Metadata

- Updated: `2026-08-27T06:51:15Z`
- Agent: Codex `/root`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Issue: Linear `SKI-6` — Adopt McpFn for Skillplane MCP runtime, authorization, and quality gates
- Skillplane base: `main` at `c13917c360b326d6199162de63df9e61e4885944`
- McpFn source: local `MCP-2` worktree at base `ab038917e7f3700a868eb8946fece2805c9439e0`
- McpFn source digest: `sha256:51bf866cc5ec5cb0ba3dee17fdbbd589f3dcaeab388c9685c25828fbde252da9`
- Publication state: publication authorized on `codex/ski-6-mcpfn-runtime`; merge, deployment, live-provider verification, and Linear status transition remain out of scope

## Status

PARTIAL — the local implementation and deterministic evidence are complete. Fresh controlled-development proof from both Claude and ChatGPT remains an external acceptance item, so `SKI-6` must not be marked Done yet.

## Root cause

Skillplane directly constructed the MCP SDK server and Streamable HTTP transport while its AuthFn plugin separately implemented OAuth protocol validation, client metadata hydration, and discovery. That duplicated the platform authorization role and left no pinned, authenticated official conformance gate. The local McpFn worktree did not yet expose all hosted-authorization and credential-adapter primitives needed for a clean production cutover.

## Implemented behavior

### McpFn platform worktree

- Added a hosted OAuth 2.1/MCP authorization compatibility layer with discovery metadata, authorization, token, refresh, revocation, dynamic registration, Client ID Metadata Documents, exact redirect matching, S256 PKCE, validated state, bounded fetches, retry metadata, and trusted-error redirect handling.
- Added provider-shaped credential authentication with per-request scope requirements and standards-shaped bearer challenges.
- Added secure redirect normalization for HTTPS and loopback callbacks and rejected wildcard hosts, userinfo, fragments, and unsafe schemes.
- Added a pinned authenticated official MCP conformance runner that proxies only to a fixed upstream and preserves the request Host header for DNS-rebinding checks.
- Preserved complete McpFn server implementation metadata rather than replacing it with defaults.

### Skillplane cutover

- Replaced direct SDK server and transport construction with `defineMcpFnServer`, McpFn tool declarations, `createWebStandardHandler`, and `createAuthProviderMcpHandler`.
- Kept Skillplane domain authorization and audit policy in Skillplane while moving protocol parsing, transport lifecycle, credential-to-`AuthInfo` adaptation, and scope challenges to McpFn.
- Reduced AuthFn MCP OAuth to persistence and consent authority behind McpFn's validated hosted-authorization contract.
- Removed the legacy dynamic-registration read/delete routes and local Client ID Metadata Document hydration. No shim, dual path, or backward-support layer remains.
- Enforced the production MCP Host and allowed loopback only outside production; DNS-rebinding attempts return `421`.
- Pinned the reviewed local McpFn worktree by base commit, source digest, package identity, and explicit local links. Published package adoption is a later reviewed replacement.

### Quality gates, evidence, and rollback

- Split deterministic contract tests from the authenticated official conformance suite.
- Added a reviewed baseline only for capabilities Skillplane does not advertise and the stateless optional SSE-session warning. Initialization, ping, tool inventory, request handling, and DNS-rebinding remain hard gates.
- Retained only `.conduct/verification/SKI-6/official-conformance-summary.json` (4,070 bytes). Raw artifacts were 17,589 bytes, were scanned for the injected service credential, and were removed after the run; the scan reported no credential material.
- Documented runtime ownership, source pinning, conformance interpretation, observability, deployment order, and paired rollback.
- No database or schema migration is required. Rollback restores the previous Skillplane runtime and the paired McpFn package set together.

## Verification

- McpFn `@mcpfn/auth`, `@mcpfn/core`, and `@mcpfn/testing` tests: PASS (`36`, `62`, and `20` tests).
- McpFn focused typecheck and builds: PASS.
- `pnpm mcpfn:verify`: PASS at base `ab038917e7f3700a868eb8946fece2805c9439e0` and digest `sha256:51bf866cc5ec5cb0ba3dee17fdbbd589f3dcaeab388c9685c25828fbde252da9`.
- `pnpm boundaries:verify`: PASS.
- `pnpm test:mcp:contract`: PASS (`8/8`).
- `pnpm test:mcp:conformance`: PASS (`1/1` authenticated run). Retained summary records `5` hard-gate successes, `25` reviewed non-advertised-capability failures, and `1` reviewed stateless-session warning.
- `pnpm test:security`: PASS, including OAuth, MCP, tenant, scope, token redaction, and DNS-rebinding coverage.
- `pnpm test:integration`: PASS (`24/24` workspace tasks; MCP `16/16`).
- `pnpm test:unit`: PASS (`28/28` workspace tasks plus `56/56` local TAP tests).
- `pnpm typecheck`: PASS (`29/29` tasks).
- `pnpm build`: PASS (`16/16` tasks; MCP Wrangler dry run only).
- Source ESLint with generated docs outputs excluded: PASS.
- Changed-surface Prettier: PASS.
- `git diff --check`: PASS in both Skillplane and the McpFn worktree.
- Secret-pattern and removed-runtime scans: PASS.

The stock `pnpm lint` command scans ignored generated `docs/.next`, `docs/.open-next`, and `docs/.source` output after a docs build. Excluding those generated directories produces a clean repository source lint. The stock `pnpm format:check` also reports three unchanged baseline files: `.github/workflows/pullfrog.yml`, `docs/lib/layout.shared.tsx`, and `scripts/verify-boundaries.mjs`. None were modified for `SKI-6`.

## Remaining acceptance evidence

Run fresh controlled-development connections from both Claude and ChatGPT against the candidate deployment and retain redacted, bounded evidence for:

- successful initialization and tool discovery;
- one real read-only Skillplane tool call;
- a denied call that proves scope enforcement;
- reconnect and OAuth refresh behavior;
- provider-visible errors and logs without token or secret material.

Only after both provider runs pass should `SKI-6` be marked Done or the rollout proceed. McpFn package publication, deployment, and production verification remain separate explicitly approved actions.

## Preserved work

- Existing untracked deployment records and the unrelated local-authority spec were not modified or included.
- Existing `.conduct` changes in the McpFn worktree were not modified.
- Unrelated `.conduct` and deployment artifacts remain unstaged and outside the Skillplane publication allowlist.
