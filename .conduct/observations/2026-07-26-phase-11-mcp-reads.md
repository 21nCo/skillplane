# PHASE_11 MCP read observations

Recorded: `2026-07-26T12:27:09Z`

## Runtime observations

1. The stable SDK Web Standard transport supports protocol `2025-11-25` and
   works with a fresh stateless server/transport for initialize, initialized,
   ping, list, and tool calls.
2. The SDK automatically advertises tool list-change support after tools are
   registered, even when the initial capability object sets
   `listChanged=false`. The conformance assertion records the actual advertised
   value; the tool inventory itself is static in this phase.
3. SDK tool output validation requires an object-rooted output schema.
   `skill_asset_retrieve` therefore uses an object schema with a runtime
   refinement that preserves the exact text/base64/download discriminant.
4. The generic MCP conformance runner's product-server scenarios assume
   fixture tools and do not expose an authorization-header CLI option. The
   project gate uses its protected production app and the official stable SDK
   client rather than introducing an unauthenticated test-only route.

## Defects found and closed

1. Public workspace search originally needed the workspace predicate inside
   authorization-filtered SQL, not as a post-ranking filter. The domain query,
   score population, and cursor scope now share the same workspace boundary.
2. The original audit constraint coupled agent/model attribution to a human
   user. Organization-owned service principals may have no delegated user, so
   migration 0012 now pairs only agent/model while leaving authenticated
   `user_id` optional.
3. A discriminated-union output schema was not advertised by the stable SDK
   and caused successful asset results to be wrapped as SDK errors. The
   object-rooted refined schema now advertises and validates correctly.
4. Generic audit-writer exceptions initially mapped to `INTERNAL_ERROR`.
   `persistMcpAudit` now converts every writer failure to the stable
   fail-closed `AUDIT_WRITE_FAILED` contract.
5. Audit and analytics initially shared one transaction. Detailed audit now
   commits first; a daily-metric failure emits a bounded safe retry signal and
   cannot roll back the disclosure audit.
6. Credential-mismatch download denials initially lacked an audit workspace
   scope. A verified signed grant now establishes resource scope before the
   credential binding check.
7. The legacy migration unit expectation omitted OAuth migration 0011. It now
   asserts the full ordered 12-migration chain.

## Boundaries

- No Superfunctions source or worktree was modified.
- No application mutation route is mounted by the MCP Worker.
- No PHASE_12 skill/context mutation tool was started.
- No production Cloudflare or Railway resource was changed.
- UI screenshots are not applicable to this backend/protocol phase.
