# Workspace skill groups

Groups are flat, many-to-many organizational collections available in personal and organization workspaces. Owners and admins can create, rename, describe, archive, restore, and assign workspace skills and current workspace members. Groups never grant or restrict access: workspace roles, credential scopes, and existing skill visibility remain authoritative.

Open **Skill groups** in workspace navigation to manage groups and inspect their skills and members. The skill catalog has a group filter; skill and member views show group links. Archived groups keep assignments and history but do not participate in normal catalog filters. Restore a group before changing its assignments. Removed workspace members remain listed with an identity-only `removed` marker (no display name or email) until an admin deletes the assignment.

The authenticated API is `/api/v1/workspaces/:workspaceId/groups`. GET lists active groups with keyset pagination (`limit` 1–100, `cursor`); `state=all` includes archived groups. `skillId` and `userId` filter associations. POST creates with `name`, `description`, and an `Idempotency-Key`. GET/PATCH `/:groupId` reads or updates metadata with `expectedRevision` and `archived`. Concurrent stale edits return 409. PUT/DELETE `/:groupId/skills/:skillId` and `/:groupId/members/:userId` are idempotent. GET `/:groupId/skills` and GET `/:groupId/members` paginate retained assignments, including for archived groups; member entries for users no longer in the workspace carry the `removed` role marker. The existing skills list/search supports `groupId` (identifier filters are trimmed; an empty `groupId`, `skillId`, or `userId` filter is rejected with 400), including query, visibility, archive, and cursor filters.

Membership administration uses authenticated human owners/admins; service credentials do not gain workspace administration privileges. Every effective mutation and assignment change writes permanent actor-attributed regional audit evidence in the same transaction. New tables live in the owning workspace cell, participate in migration fencing, and are copied during workspace movement. The global membership authority validates member identities; regional data does not introduce a cross-database foreign key or an access grant.

Apply migration `0052_regional_skill_groups.sql` to regional and combined databases before enabling these surfaces. No backfill is required. Rollback disables the surfaces while retaining group records and immutable audit history.

Group detail lists retained skill assignments, including archived groups and skills.
Removed workspace members show an identity-only removed marker until an admin
removes the assignment; they receive no membership grant. Member views link to a
member-filtered group list, avoiding per-row requests for the workspace roster.
