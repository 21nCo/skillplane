# Application data-operation ownership

This matrix is the architecture decision for first-party Skillplane application traffic. It distinguishes a typed read path from commands whose correctness depends on locks, idempotency, audit, or coordinated Postgres and R2 state.

## Approved DataFn reads

| Operation                                                            | First-party canonical path              | Reason                                                                    |
| -------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------- |
| Authenticated skill list, pagination, archive and visibility filters | `@skillplane/datafn` to `/datafn/query` | Tenant-filtered regional metadata read; this is the skills-page hot path. |
| Authenticated skill detail by ID or workspace-local slug             | `@skillplane/datafn` to `/datafn/query` | Tenant-filtered regional metadata read.                                   |
| Authenticated skill version metadata and history                     | `@skillplane/datafn` to `/datafn/query` | Immutable regional metadata read.                                         |

The SvelteKit app must use the shared `withWorkspaceDatafnReadClient` boundary for every operation above. When direct routing is enabled, that boundary authenticates one ticket-bootstrap request through the canonical gateway, caches the short-lived route grant in memory, and sends read traffic without cookies to the ticket-authorized regional DataFn endpoint. The selected workspace remains only a requested namespace: the gateway verifies the AuthFn session, membership, and placement before issuing the grant, while the regional DataFn server verifies the ticket and derives the principal again before applying mandatory row-level namespace filtering. Recoverable transport, expiry, or placement failures temporarily fall back to canonical `/datafn`; policy denials remain terminal.

## Hono reads retained by design

| Operation                                                 | Canonical path                                 | Why it is not in this migration                                                                                                                                                                |
| --------------------------------------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Full-text skill search                                    | `/api/v1/workspaces/:workspaceId/skills?q=...` | Preserves domain indexing of tags, published instructions and context text, relevance ranking, and signed search cursors until DataFn has equivalent behavior.                                 |
| Workspace inventory and placement recommendation          | `/api/v1/workspaces`                           | Global, cross-workspace control-plane bootstrap; a regional DataFn namespace does not exist until a workspace is selected.                                                                     |
| Public skill pages and projections                        | `/api/v1/skills/public/*`                      | Global sanitized projection with public cache policy, not a private regional read.                                                                                                             |
| Bundle, file, and diff retrieval                          | `/api/v1/skills/*`                             | Requires authorization plus R2 access or computed output rather than a table read.                                                                                                             |
| Contexts, knowledge, notes, reviews, analytics, and audit | Existing `/api/v1` reads                       | Their DataFn resources remain available, but first-party migration is deferred until each composite response and pagination contract has parity tests. They are not approved DataFn reads yet. |

The corresponding private skill read handlers remain temporarily as external API compatibility surfaces. Except for full-text search, they are not called by the first-party app. Removing or versioning those public contracts is a separate compatibility decision.

## Domain commands

All writes remain Hono/domain-service commands, including skill creation, candidate save, amendment, publication, archive/restore, review decisions, context and note changes, invitation delivery, OAuth issuance, and any workflow requiring locks, expected-version checks, idempotency, audit, compensation, or coordinated R2/Postgres state.

The approved DataFn mutation set is currently empty. Generic DataFn mutations remain denied by server policy.

## Transport evolution

The current client can route approved reads directly with AUTH-2 placement-bound context and DATA-4 gateway-issued regional tickets. Authentication, ticket bootstrap, placement, public projections, and domain commands continue through the canonical gateway. Disabling the rollout flag switches the shared boundary back to canonical `/datafn` without feature-level changes.

List cursors bind the workspace, normalized query, archive state and visibility set. Reusing a cursor with different filters returns `CURSOR_FILTER_MISMATCH` before sending a query. Authenticated skill detail reads continue to include archived skills, matching the existing detail endpoints.
