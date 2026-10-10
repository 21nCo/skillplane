# PHASE_12 — MCP amendments and context-note mutations

## Phase goal

Expose production MCP mutation tools for controlled skill improvement and context-note maintenance with policy, concurrency, idempotency, and audit guarantees.

## In scope

- `skill_amend`.
- `context_note_upsert`.
- Context knowledge mutation tool if required by final MCP naming review.
- Scope/role/policy enforcement.
- Idempotency and conflict responses.
- Mutation audit.

## Out of scope

- Automatic execution of skill scripts.
- Private per-agent notes.
- New domain semantics outside existing app workflows.

## Deliverables

- `packages/mcp-schema/src/amend.ts`
- `packages/mcp-schema/src/context-mutations.ts`
- `mcp/src/tools/amend.ts`
- `mcp/src/tools/context-mutations.ts`
- `mcp/src/tools/index.ts`
- MCP mutation fixtures and end-to-end tests
- engineering log, phase report, and ledger append

## Requirements covered

- `SKL-006`
- `SKL-007`
- `SKL-008`
- `CTX-005`
- `MCP-002`
- `MCP-006`
- `MCP-007`
- `MCP-008`
- `AUD-001`
- `AUTH-007`
- `AUTH-008`
- `QA-001`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Define exact mutation schemas with caller declaration and tool annotations.
2. Reuse domain services used by the app; do not create MCP-specific amendment semantics.
3. Enforce OAuth/API scope, workspace role, skill policy, base version, expected digest, paths, limits, and learning metadata.
4. Implement idempotency success replay and changed-payload rejection.
5. Implement candidate creation and trusted auto-publication policy result.
6. Implement context note create/update with expected revision and idempotency.
7. Map stable domain errors to safe MCP errors.
8. Write mutation audit in the same database transaction as durable mutation metadata.
9. Add concurrent agent and retry tests.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/mcp-schema -- amend contexts
pnpm test:integration --filter mcp-mutations
pnpm test:security --filter mcp-mutations
pnpm test:mcp:conformance
pnpm test:mcp:e2e
```

Expected outcomes:

- Valid amendments create exactly one candidate.
- Valid note upserts create one immutable revision.
- Retries, stale bases, conflicts, unsafe paths, invalid metadata, wrong scopes, and policy denials behave deterministically.
- Audit and caller metadata are complete.

## Stop condition

Report mutation tool schemas, idempotency/concurrency matrix, candidate results, and audit evidence before `PHASE_13`.
