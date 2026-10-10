# PHASE_08 context-knowledge observations

## Product workflow

Contexts are a first-class tab within a skill. The inventory uses one explicit
lifecycle filter, typed context badges, external references, knowledge
revision numbers, and compact two-column cards at desktop width. The layout
collapses to a single column without hiding context identity or lifecycle.

Creation collects retrieval metadata and the initial shared Markdown document
in one transaction. Context metadata and learning metadata remain visually
and semantically distinct. Native required-field feedback blocks incomplete
submissions, and a successful creation lands on the real persisted detail
route.

The detail page separates three concepts:

- retrieval metadata identifies the repository, project, customer, or
  environment;
- shared context knowledge is the current broad source of truth;
- named notes retain focused decisions or conventions.

Both knowledge and notes render sanitized Markdown, retain exact source, and
expose learning metadata. History shows digests, base links, author type,
optional agent/model declarations, exact Markdown, and every immutable
revision.

## Conflict behavior

The browser opened knowledge revision 1, then an independent API call committed
revision 2. Saving the stale editor returned
`CONTEXT_REVISION_CONFLICT`. The editor kept the draft, stated that revision 2
was current, and offered an explicit Load current revision action. No
last-write-wins update occurred. After the user loaded revision 2 and amended
again, revision 3 was committed and survived reload.

The integration suite proves the same concurrency rule for knowledge and
notes: two writes using one expected revision produce one winner and one typed
conflict. Immutable history contains the original documents and linked bases.

## Authorization and lifecycle

Viewers can inspect all visible context knowledge, learning metadata, notes,
and history, but no create/edit/archive controls are rendered. A direct viewer
mutation still returns `403`, so the UI is not the security boundary.

Tenant and skill predicates are applied before resource reads. Cross-workspace
IDs and a valid slug under the wrong skill return non-leaking `404` responses.
DataFn resources use the same tenant identity and did not serialize an
outsider fixture.

Context archive removes the context from active retrieval while retaining
knowledge and note history. Note archive removes the note from the default
active list while keeping it visible through the archived filter. Context
restore returns the context to active retrieval.

## Accessibility matrix

| Route family | 390x844 | 768x1024 | 1440x900 |
|---|---:|---:|---:|
| Context inventory | 0 violations | 0 violations | 0 violations |
| Context detail | 0 violations | 0 violations | 0 violations |
| Knowledge history | 0 violations | 0 violations | 0 violations |
| Note history | 0 violations | 0 violations | 0 violations |

Every route was checked in dark and light themes using WCAG 2.0 A/AA, 2.1 AA,
and 2.2 AA tags. There was no page-level horizontal overflow. Keyboard tests
cover the inline creator and three dialog families, including Escape and focus
restoration.

## Narrative screenshot index

| Screenshot | Observation |
|---|---|
| `contexts-error-retry-desktop-dark.png` | storage failure is distinct and retryable |
| `context-create-validation-desktop-dark.png` | required fields block context creation |
| `context-detail-created-desktop-dark.png` | revision 1, metadata, reference, and learning summary persist |
| `context-knowledge-conflict-desktop-dark.png` | current revision is named and stale draft is preserved |
| `context-note-history-desktop-dark.png` | note revisions 2 and 1 show bases, digests, and exact history |
| `context-archive-confirmation-desktop-dark.png` | destructive impact and preservation guarantee are explicit |
| `context-archived-desktop-dark.png` | archived state persists while knowledge remains readable |
| `context-viewer-authorization-desktop-dark.png` | viewer receives complete read-only context knowledge |
| `context-detail-mobile-light.png` | real revision 3 detail fits 390 pixels in the light theme |

Manual inspection found a restrained Linear-inspired hierarchy, readable
metadata/source regions, clearly differentiated conflict/destructive states,
and no clipped primary control in the final mobile capture. Modal screenshot
evidence is viewport-based so the backdrop and dialog remain truthful.
