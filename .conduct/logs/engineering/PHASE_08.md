# PHASE_08 engineering log

- Started: `2026-07-26T09:35:00Z`
- Completed: `2026-07-26T10:17:22Z`
- Status: `COMPLETE — PASS`
- Scope: typed per-skill contexts, immutable shared context knowledge and
  named-note revisions, optimistic concurrency, idempotency, tenant-safe
  Hono/DataFn access, lifecycle UI, revision history, and objective
  browser/accessibility evidence.

## Implemented

1. Added migration `0009_contexts_notes.sql` to complete the existing context
   foundation with the five context types, external references, same-parent
   base-revision foreign keys, SHA-256 body digests, immutable note titles,
   size constraints, and append-only revision protection.
2. Added strict domain contracts for context slug/name/type/reference,
   lifecycle filters, JSON metadata, Markdown byte bounds, maximum context and
   note counts, and deterministic digests.
3. Added atomic context creation that commits the context and shared knowledge
   revision 1 together. Duplicate slugs are rejected within a skill while the
   same slug remains valid under another skill.
4. Added shared knowledge current/history/update operations. Updates lock the
   current context row, require the expected revision, link the immutable base,
   carry learning metadata and actor declarations, and support exact
   idempotency replay.
5. Added named shared notes with current/list/history/create/update/archive
   operations, immutable title/body revisions, expected-revision conflicts,
   active/archive filters, idempotency, and per-context limits.
6. Added Hono routes for context, knowledge, and note operations and corrected
   nested-route authorization matching so context reads/writes are evaluated
   before generic skill routes.
7. Added tenant-filtered DataFn resources for contexts, knowledge revisions,
   notes, and note revisions. DataFn remains read-only for these invariants;
   Hono/domain services are the sole mutation authority for locking,
   idempotency, and conflict semantics.
8. Added context inventory, creation, profile editing, detail, safe Markdown,
   exact source, learning metadata, notes, immutable history, lifecycle
   confirmations, typed conflict recovery, viewer states, and responsive
   routes to the Svelte application.
9. Added focused domain, integration, security, persisted-browser, and WCAG
   matrix suites plus deterministic test-fixture cleanup for immutable
   revision tables.
10. Added focused-suite dependency prebuilds so integration/security commands
    cannot accidentally run against stale package distributions.

## Revision and concurrency evidence

- Context creation returned knowledge revision `1`, `baseRevisionId: null`, and
  a stable `sha256:` digest.
- The API integration workflow created knowledge revision `2` linked to
  revision `1`; history returned `[2, 1]` without changing revision 1.
- Two simultaneous knowledge writes with `expectedRevision: 2` returned
  exactly one `200` and one `409 CONTEXT_REVISION_CONFLICT`; the conflict
  reported current revision `3`.
- Note history followed the same pattern: revisions `[3, 2, 1]`, with one
  winner and one typed conflict for simultaneous expected-revision-2 writes.
- Replaying the same mutation and idempotency key returned the original
  resource. Reusing the key for a different request returned
  `409 IDEMPOTENCY_KEY_REUSED`.
- Database triggers reject updates/deletes of knowledge and note revisions,
  while same-parent foreign keys prevent invalid base links.

## Authorization matrix

| Role / boundary | Read contexts, knowledge, notes, history | Create/update/archive |
|---|---:|---:|
| Viewer | allowed | denied `403` |
| Editor | allowed | allowed |
| Admin | allowed | allowed |
| Owner | allowed | allowed |
| Other workspace | non-leaking `404` | denied before data access |
| Wrong skill + context slug | non-leaking `404` | not applicable |

The security suite issued five viewer mutations covering context creation,
knowledge update, note creation, note update, and context archive. All returned
`403 WORKSPACE_FORBIDDEN`, and before/after row counts were identical. Six
cross-workspace resource reads plus a cross-skill slug lookup returned `404`
without body, title, or digest leakage.

## Persisted browser workflow

1. A forced context-list `503 DATABASE_UNAVAILABLE` rendered an actionable
   error and recovered through Retry.
2. Native validation blocked an empty context submission.
3. The browser created repository context `btnextjs` with typed metadata,
   external reference, learning metadata, and immutable knowledge revision 1.
4. Reload preserved the context, exact knowledge, metadata, and current
   revision.
5. While the knowledge editor held revision 1, an external request committed
   revision 2. The browser submission displayed the typed conflict, retained
   the unsaved source, and did not overwrite revision 2.
6. Explicitly loading the current revision and resubmitting created revision 3;
   reload preserved it.
7. The browser created note revision 1, reloaded it, amended revision 2,
   reloaded it, and inspected both immutable revisions and their learning
   metadata in history.
8. Note archive removed the note from the active filter while keeping it in
   archived history.
9. Context archive persisted after reload and excluded the context from active
   retrieval; restore persisted after another reload.
10. A viewer received the read-only UI and a direct knowledge `PUT` returned
    `403 FORBIDDEN`.
11. The final context detail rendered at `390x844` in the light theme after
    waiting for persisted data, with no horizontal overflow.

## Accessibility and screenshot evidence

- Axe scanned context list, detail, knowledge history, and note history at
  `390x844`, `768x1024`, and `1440x900` in dark and light themes: 24 checked
  route/theme/viewport combinations, zero violations.
- The same suite checks page overflow, keyboard activation, inline-creator
  focus return, modal initial focus, Escape close, and focus restoration for
  knowledge, note archive, and context archive dialogs.
- Nine narrative screenshots record retry, validation, creation, typed
  conflict, note history, destructive confirmation, archived state, viewer
  authorization, and the mobile layout.
- Manual review found and fixed a context-created URL incorrectly triggering
  the parent skill-created banner and an early mobile loading-state capture.
  The final screenshots contain neither defect.

## Defects found and closed

- The pre-existing context tables lacked typed context fields, revision base
  links, digests, immutable note titles, and production byte constraints.
- Initial Drizzle/DataFn edits briefly placed context columns on the skill
  record; source inspection and focused integration coverage caught and
  corrected the mapping before final verification.
- Focused integration/security commands could consume stale `dist` output.
  Their runners now build the complete focused dependency closure first.
- The inline creator did not return keyboard focus on Cancel. It now returns
  focus to the New context trigger.
- A shared `?created=true` query was interpreted by the skill layout on nested
  context routes. The success banner is now scoped to the exact skill overview.
- Full-page modal captures produced misleading overlay composition; modal
  evidence now uses the active viewport, and conflict evidence scrolls the
  typed alert into view.

## Final verification

```text
pnpm test:unit --filter @skillplane/domain -- contexts
PASS — 6/6

pnpm test:integration --filter contexts
PASS — 1/1 comprehensive API/DataFn scenario

pnpm test:security --filter context-isolation
PASS — 1/1 role and tenant-isolation scenario

pnpm test:e2e --grep @contexts
PASS — 2/2 persisted browser workflows

pnpm test:a11y --filter context-pages
PASS — 1/1 matrix scenario, 24 route/theme/viewport checks plus dialogs

pnpm lint
PASS

pnpm typecheck
PASS — 23/23 tasks, zero Svelte warnings

pnpm format:check
PASS

pnpm boundaries:verify
PASS — WORKSPACE_BOUNDARIES_VALID

pnpm lint:design-system
PASS — DESIGN_SYSTEM_POLICY_PASSED

pnpm client-secrets:verify
PASS — CLIENT_BUNDLES_SECRET_FREE

pnpm build
PASS — 13/13 package builds, including Cloudflare Worker dry-runs
```

## External boundaries

No Superfunctions worktree or source file was modified in PHASE_08.
