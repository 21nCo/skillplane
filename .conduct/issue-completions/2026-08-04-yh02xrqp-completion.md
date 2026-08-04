# Linear Agent Skillplane MCP connector completion

## Metadata

- Timestamp: `2026-08-04T12:19:39Z`
- Agent name: `unknown-agent`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: repository root
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `main`
- Final implementation commit: `39166ec`
- Issue source: user-provided Linear Agent failure while the Skillplane MCP connector was active

## Issue summary

Linear completed OAuth, MCP initialization, and `tools/list`, but failed before issuing a tool call. The complete 27-tool Skillplane catalog serialized to approximately 143.8 KiB. Removing output schemas reduced it to approximately 69 KiB, and removing additional optional metadata reduced it to 63,591 bytes, but Linear still rejected the connector before orchestration. Advertising a successful long-lived SSE GET caused Linear to wait indefinitely, confirming that stateless GET should remain a `405 Method Not Allowed` response.

The final fix recognizes Linear by its authenticated OAuth client ID, preserves all 27 tools, and advertises a Linear-specific compact input contract of 28,028 bytes. It removes redundant caller fields and validation-only JSON Schema keywords from Linear's catalog while retaining tool names, descriptions, types, properties, required fields, enums, and unions. On `tools/call`, the server injects clearly labeled `Linear Agent` caller metadata before the existing strict MCP validation and audit path. Other MCP clients continue to receive the complete schemas and metadata.

## Status

PASS

## Requirements summary

### Fix the Linear Agent connector failure

- Status: PASS
- Evidence: Linear rendered the result `You can access 2 Skillplane workspaces through the active connector: 21n — organization workspace; ar — personal workspace. In both, your role is owner.`
- Production trace: Worker version `12234c17-5d83-4ffe-a960-c9e5f8665828` received the Linear request from Google infrastructure, invoked `workspaces_list`, logged `outcome:"success"`, and returned HTTP 200.

### Preserve MCP contracts for other clients

- Status: PASS
- Evidence: conformance coverage asserts that non-Linear clients still receive all 27 complete tools with annotations and output schemas.
- Test status: the MCP conformance suite passed 8/8 tests.

### Preserve validation and audit behavior

- Status: PASS
- Evidence: Linear caller metadata is injected before the existing runtime, schema validation, authorization, and audit layers; it is not trusted from the advertised tool input.
- Test status: security tests passed 26/26 and the caller-injection regression passed.

### Commit and push the implementation

- Status: PASS
- Evidence: implementation commits `1af4f3e`, `fd292bc`, `287d63d`, `343b6cb`, `1018524`, and final `39166ec` were pushed to `origin/main`.
- Notes: intermediate commits captured transport and catalog-size experiments; `39166ec` is the final client-specific contract adapter.

### Deploy and verify production

- Status: PASS
- Evidence: the MCP Worker deployed as version `12234c17-5d83-4ffe-a960-c9e5f8665828`; prior version `d3d63560-bb54-4d30-af33-349a0934fc32` remains the rollback target.
- Test status: production smoke returned `ok: true` with application and landing TLS/HTTP checks, MCP bearer challenge, Postgres, R2, OAuth issuer/resource, PKCE S256, and private-boundary checks passing.

## Implementation summary

### Files changed or added

- `mcp/src/index.ts`
- `mcp/tests/conformance/mcp.conformance.test.ts`
- `mcp/tests/integration/mcp-read.integration.test.ts`
- `.conduct/issue-completions/2026-08-04-yh02xrqp-completion.md`
- `.conduct/tracker.csv`
- `.conduct/logs.csv`

### Files deleted

- None.

### Key changes

- Detect the Linear OAuth client by the exact registered client-metadata URL.
- Compact only Linear's advertised tool contracts to fit the Agent's orchestration budget while retaining all 27 capabilities.
- Remove the caller object from Linear's advertised inputs and inject server-owned `Linear Agent` caller metadata before normal request handling.
- Preserve full contracts for all non-Linear MCP clients.
- Keep the optional stateless SSE GET unavailable with the standards-compatible `405` response.

## Verification summary

### Verification steps executed

- Scoped Prettier check — PASS.
- Scoped ESLint check — PASS.
- MCP typecheck — PASS.
- MCP conformance suite — PASS, 8/8 tests.
- MCP security suite — PASS, 26/26 tests.
- MCP integration suite — PASS, 16/16 tests.
- MCP unit suite — PASS, 9/9 tests.
- MCP E2E suite — PASS, 6/6 tests.
- `pnpm deploy:check` — PASS, 17/17 tasks including production application and MCP dry-runs.
- Clean detached production MCP build — PASS, 13/13 tasks.
- `pnpm deploy:mcp` — PASS, Worker version `12234c17-5d83-4ffe-a960-c9e5f8665828` published on `mcp.skillplane.dev`.
- `pnpm smoke:production` — PASS, `ok: true` at `2026-08-04T12:16:55.138Z`.
- Real Linear Agent MCP invocation — PASS, rendered two accessible workspaces and corresponding Worker `workspaces_list` success trace.

### Manual verification

- Opened a new Linear Agent chat with the Skillplane connector active.
- Sent `Use Skillplane to list the workspaces I can access through the active MCP connector.`
- Confirmed the Agent completed in ten seconds and rendered the two live workspace results rather than the previous generic error.
- Confirmed the exact production Worker version served initialization, declined optional SSE GET with 405, served the compact tool catalog, received a subsequent tool call, and completed `workspaces_list` successfully.

## Notes

- The MCP Worker was the only deployment target because the authorization fix was already deployed and this failure occurred after successful OAuth and tool discovery.
- The deployment was built from a clean detached worktree at `39166ec`; unrelated local conduct audit changes were excluded.
- The final change does not alter persistence schemas or require a database migration.
- One security-suite attempt run concurrently with integration encountered a PostgreSQL serialization conflict; the isolated required security run passed all 26 tests.
- The previous MCP Worker version remains available for rollback.

## Blockers

- None.
