# PHASE_02 data-foundation observations

- Captured: 2026-07-26T05:31:51Z
- Scope: local Postgres migrations, query plans, tenant isolation, DataFn
  exposure, HTTP composition, and database recovery
- Result: PASS

## Migration inventory

The migration runner applied and hash-verified these forward-only migrations:

1. `0001_authfn_core.sql`
2. `0002_skillplane_domain.sql`
3. `0003_integrity_search_retention.sql`
4. `0004_fix_published_version_transition.sql`

A fresh test reset applied all four migrations. Re-running the production-style
local migration command applied none and verified the existing hashes. Migration
execution is serialized by a Postgres advisory lock and recorded in
`skillplane_schema_migrations`.

## Schema inventory

`pnpm db:verify` found 19 required tables:

```text
amendment_reviews
analytics_daily
api_rate_limits
audit_events
authfn_sessions
authfn_users
context_knowledge_revisions
context_note_revisions
context_notes
idempotency_records
service_principals
skill_contexts
skill_version_files
skill_versions
skillplane_schema_migrations
skills
workspace_invitations
workspace_memberships
workspaces
```

All application tables exposed through DataFn carry a `workspace_id` boundary.
Composite foreign keys prevent a child ID from being paired with a different
workspace. Database constraints also enforce slug, digest, semantic-version,
role, scope, attribution, size, publication, revision, and current-pointer
invariants.

Eight protection triggers were present:

```text
audit_events_immutable
context_knowledge_revisions_immutable
context_note_revisions_immutable
context_notes_current_revision_valid
skill_contexts_current_knowledge_valid
skill_version_files_protect_published
skill_versions_protect_published
skills_current_version_valid
```

## Query-plan evidence

`pnpm db:verify` required an index-backed plan for every phase-owned lookup:

| Query path | Index selected |
|---|---|
| workspace slug | `workspaces_slug_key` |
| tenant skill slug | `skills_workspace_updated_idx` |
| tenant skill revision | `skill_versions_workspace_skill_revision_idx` |
| tenant context slug | `skill_contexts_workspace_skill_idx` |

The empty local database planner selected the tenant/update skill index for the
skill-slug probe. The stricter `skills_workspace_slug_unique` constraint is
also present and verified in the schema inventory.

## Tenant and authorization observations

- DataFn exposes nine read-only resources: workspaces, memberships, skills,
  versions, contexts, context knowledge revisions, notes, note revisions,
  amendment reviews, and daily analytics.
- AuthFn users/sessions, invitations, service-principal credentials, R2 file
  records, audit events, idempotency state, and rate-limit state are not DataFn
  resources.
- DataFn authenticates through AuthFn, resolves membership before querying,
  injects the authenticated workspace namespace, and rejects generic mutation,
  transaction, seed, and sync operations.
- Cross-workspace DataFn queries and Hono skill searches returned no protected
  records in both integration and security suites.
- Viewer, editor, admin, and owner permissions are covered by the canonical
  authorization matrix. Service principals use explicit scopes.
- Requests carry a request ID plus authenticated user, agent, model, workspace,
  and role context where present; errors do not disclose foreign-workspace
  existence.

## Recovery observation

`pnpm db:backup:verify`:

```json
{
  "ok": true,
  "backupBytes": 76807,
  "restoredDatabase": "skillplane_restore_test",
  "migrations": [
    "0001_authfn_core.sql",
    "0002_skillplane_domain.sql",
    "0003_integrity_search_retention.sql",
    "0004_fix_published_version_transition.sql"
  ],
  "tables": 19
}
```

The command created a custom-format `pg_dump`, restored it into an isolated
local test database, verified all tables and migrations, and dropped the
temporary restore database. The ignored backup artifact remains available at
`.data/backups/skillplane-verification.dump`.

## Compatibility boundaries

- Released immutable packages are used:
  `@authfn/core@0.1.1`, `@datafn/core@0.0.3`,
  `@datafn/server@0.0.3`, `@datafn/client@0.0.3`, and
  `@superfunctions/db@0.1.4`.
- External Superfunctions and Nucleus worktrees were inspected read-only and
  were not modified.
- Drizzle `0.45.2` declaration files include unused drivers that are not yet
  TypeScript 6 clean. `skipLibCheck` is scoped to packages that transitively
  consume Drizzle; Skillplane source remains strict and the complete typecheck
  passes.

No UI screenshots are required for this non-UI phase.
