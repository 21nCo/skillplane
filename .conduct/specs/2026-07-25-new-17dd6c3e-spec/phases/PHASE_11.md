# PHASE_11 — MCP search, retrieval, assets, versions, and context reads

## Phase goal

Expose the complete authorized MCP read surface with exact versioned content, context composition, caller metadata, and fail-closed audit.

## In scope

- Streamable HTTP MCP lifecycle.
- Protected-resource challenge.
- `skills_search`.
- `skill_retrieve`.
- `skill_asset_retrieve`.
- `skill_versions_list`.
- `context_get`.
- `context_notes_list`.
- Read audit and metrics.

## Out of scope

- Skill and context mutations.
- Analytics UI.

## Deliverables

- `packages/mcp-schema/src/caller.ts`
- `packages/mcp-schema/src/errors.ts`
- `packages/mcp-schema/src/search.ts`
- `packages/mcp-schema/src/retrieve.ts`
- `packages/mcp-schema/src/assets.ts`
- `packages/mcp-schema/src/versions.ts`
- `packages/mcp-schema/src/contexts.ts`
- `packages/mcp-schema/src/index.ts`
- `mcp/src/auth.ts`
- `mcp/src/server.ts`
- `mcp/src/tools/search.ts`
- `mcp/src/tools/retrieve.ts`
- `mcp/src/tools/assets.ts`
- `mcp/src/tools/versions.ts`
- `mcp/src/tools/contexts.ts`
- `mcp/src/index.ts`
- MCP protocol, R2, authorization, audit, and size tests
- engineering log, phase report, and ledger append

## Requirements covered

- `CTX-004`
- `MCP-001`
- `MCP-002`
- `MCP-003`
- `MCP-004`
- `MCP-005`
- `MCP-007`
- `MCP-008`
- `AUD-001`
- `AUTH-008`
- `QA-001`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Implement Streamable HTTP session handling and version negotiation.
2. Validate OAuth/PAT credential, audience, scopes, workspace role, and caller declaration for every call.
3. Register tools with exact schemas, descriptions, and read-only annotations.
4. Implement authorization-filtered full-text search and opaque cursors.
5. Implement exact version selectors, R2 content validation, manifest, instructions, and optional context composition.
6. Implement size/media-aware asset reads and authorization-bound download paths.
7. Implement authorized version and context histories.
8. Write detailed audit before returning private content; fail closed if audit persistence fails.
9. Add MCP client integration fixtures for interactive OAuth and service credentials.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/mcp-schema
pnpm test:integration --filter mcp-read
pnpm test:security --filter mcp-read
pnpm test:mcp:conformance
pnpm build --filter mcp
```

Expected outcomes:

- OAuth discovery and MCP initialization succeed.
- All read tools return exact authorized content and digests.
- Missing caller fields, wrong scope/audience, cross-tenant IDs, unsafe assets, and audit failure fail safely.
- Public and private visibility behavior is consistent.

## Stop condition

Report MCP conformance output, tool schemas, exact digest proof, scope matrix, and audit fail-closed evidence before `PHASE_12`.
