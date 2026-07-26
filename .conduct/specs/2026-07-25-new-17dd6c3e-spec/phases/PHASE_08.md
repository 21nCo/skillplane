# PHASE_08 — Context knowledge and shared notes

## Phase goal

Deliver typed per-skill contexts with immutable shared knowledge and note revisions across API, DataFn, UI, and authorization.

## In scope

- Context metadata and lifecycle.
- Shared context knowledge revision stream.
- Shared named note revision streams.
- Optimistic concurrency and idempotency.
- Context and note UI/history.

## Out of scope

- MCP tools.
- Promotion of context learning into skill content.
- Private per-agent notes.

## Deliverables

- `packages/domain/src/contexts.ts`
- `packages/domain/src/context-knowledge.ts`
- `packages/domain/src/context-notes.ts`
- `packages/api/src/routes/contexts.ts`
- `packages/api/src/routes/context-notes.ts`
- DataFn resource/policy additions
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]/history/+page.svelte`
- `app/src/lib/contexts/ContextEditor.svelte`
- `app/src/lib/contexts/KnowledgeEditor.svelte`
- `app/src/lib/contexts/NoteEditor.svelte`
- `app/src/lib/contexts/RevisionHistory.svelte`
- domain/API/UI tests and screenshot evidence
- engineering log, phase report, and ledger append

## Requirements covered

- `CTX-001`
- `CTX-002`
- `CTX-003`
- `CTX-005`
- `AUTH-004`
- `UI-002`
- `UI-004`
- `UI-005`
- `QA-002`
- `QA-004`

## Implementation tasks

1. Implement context types, slug uniqueness, external references, metadata, and archive.
2. Implement shared knowledge create/read/update/history with expected revision and idempotency.
3. Implement note create/read/update/list/history/archive with expected revision and idempotency.
4. Add DataFn authorized read models and safe mutations.
5. Build context list/detail, knowledge editor, notes, and history UI.
6. Render Markdown safely and preserve exact source editing.
7. Expose conflict resolution without silent last-write-wins.
8. Verify concurrent updates, cross-skill selection, role denial, archive, and persistence.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/domain -- contexts
pnpm test:integration --filter contexts
pnpm test:security --filter context-isolation
pnpm test:e2e --grep @contexts
pnpm test:a11y --filter context-pages
```

Expected outcomes:

- Context and note revisions are immutable.
- Concurrent updates produce one success and one typed conflict.
- Cross-skill and cross-workspace access leaks nothing.
- Browser state survives reload.

## Stop condition

Report revision/concurrency evidence, authorization matrix, persistence E2E, and context screenshots before `PHASE_09`.
