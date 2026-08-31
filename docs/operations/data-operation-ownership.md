# Application data-operation ownership

This matrix is the architecture decision for first-party Skillplane application traffic. It distinguishes a typed read path from commands whose correctness depends on locks, idempotency, audit, or coordinated Postgres and R2 state.

## Approved DataFn reads

| Operation                                                                                  | First-party canonical path              | Reason                                                                    |
| ------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------------- |
| Authenticated skill list, pagination, archive and visibility filters, and full-text search | `@skillplane/datafn` to `/datafn/query` | Tenant-filtered regional metadata read; this is the skills-page hot path. |
| Authenticated skill detail by ID or workspace-local slug                                   | `@skillplane/datafn` to `/datafn/query` | Tenant-filtered regional metadata read.                                   |
| Authenticated skill version metadata and history                                           | `@skillplane/datafn` to `/datafn/query` | Immutable regional metadata read.                                         |

The SvelteKit app must use the shared `withWorkspaceDatafnClient` boundary for every operation above. The client sends the selected workspace as a requested namespace, but that value is not an authorization grant: the gateway authenticates the AuthFn session, checks membership in the control-plane directory, resolves placement, and sends a signed assertion to the owning cell. The regional DataFn server derives its principal again and applies mandatory row-level namespace filtering.

## Hono reads retained by design

| Operation                                                 | Canonical path            | Why it is not in this migration                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace inventory and placement recommendation          | `/api/v1/workspaces`      | Global, cross-workspace control-plane bootstrap; a regional DataFn namespace does not exist until a workspace is selected.                                                                     |
| Public skill pages and projections                        | `/api/v1/skills/public/*` | Global sanitized projection with public cache policy, not a private regional read.                                                                                                             |
| Bundle, file, and diff retrieval                          | `/api/v1/skills/*`        | Requires authorization plus R2 access or computed output rather than a table read.                                                                                                             |
| Contexts, knowledge, notes, reviews, analytics, and audit | Existing `/api/v1` reads  | Their DataFn resources remain available, but first-party migration is deferred until each composite response and pagination contract has parity tests. They are not approved DataFn reads yet. |

The corresponding private skill read handlers remain temporarily as external API compatibility surfaces. They are not called by the first-party app. Removing or versioning those public contracts is a separate compatibility decision.

## Domain commands

All writes remain Hono/domain-service commands, including skill creation, candidate save, amendment, publication, archive/restore, review decisions, context and note changes, invitation delivery, OAuth issuance, and any workflow requiring locks, expected-version checks, idempotency, audit, compensation, or coordinated R2/Postgres state.

The approved DataFn mutation set is currently empty. Generic DataFn mutations remain denied by server policy.

## Transport evolution

The current client uses the canonical `/datafn` gateway so AuthFn session cookies and workspace membership remain authoritative. After AUTH-2 and DATA-4 provide placement-bound auth context and gateway-issued direct-regional tickets, the same client boundary can switch its query transport without changing feature code. Authentication/bootstrap and domain commands will continue through the canonical gateway.
