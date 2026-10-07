# Git skill sources

Workspace owners and admins can connect **public GitHub repositories** from
**Git sources**. A source imports either all discovered `SKILL.md` directories or
one repository-relative directory (including an empty directory for repository
root). No particular parent folder name is required. Choose a tracked branch/tag
for manual updates, or pin a full 40-character commit SHA. Repository and path
scope stay fixed after creation; archive a source and create another to change
scope. Ref policy and ref can be edited with an expected revision.

## Preview and apply

Preview resolves a ref to an immutable commit and stores a bounded plan. Apply
requires that exact run ID, fetches the pinned commit again, verifies content,
and rejects stale source revisions. Each item reports added, changed, unchanged,
missing, conflict, or invalid content. New skills are **private** and use the
existing initial-publication flow. Changes to an existing skill create a
`pending_review` version through the normal version service. Owners/admins review
and publish or reject those versions in the existing version UI.

Bindings are explicit. A matching manual skill slug reports a conflict until the
owner chooses **Bind an existing workspace skill**; imports never silently attach
manual skills. Changed published heads, archived targets, renamed slugs, and
rejected imported candidates require review. Missing/renamed source paths retain
the existing skill and history. Disconnect a binding to resolve a rename or attach the skill to a different source;
this retains its versions, provenance, and the disconnected mapping. Archive stops
sync but preserves bindings,
runs, versions, and provenance. Restoring permits another preview.

Repeated content creates no version, even when the commit changes. Apply retries
reuse the same run and per-item idempotency keys; version and Git provenance commit
atomically. A retry also recovers a committed version whose binding/result write
failed. A bounded, renewable database lease serializes sync for each source and
prevents settings/binding edits while it runs. Completed syncs invalidate older
previews. A new preview is required to apply corrected content at another commit.

## Provenance and storage

Each imported version records repository URL, resolved commit SHA, directory,
canonical bundle digest, source/run IDs, and import timestamp. The database rejects
provenance updates and edits to stored preview identity/plan. Version overview and
review pages show provenance; source detail lists all bindings and recent runs.
Catalog discovery supports a source filter with filter-bound pagination.

All four tables belong to the regional workspace database and participate in
workspace-copy/checksum/cleanup ownership and routing fences. Apply migration
`0053_regional_git_sources.sql` to regional and combined databases **before**
running this application; global control databases do not receive these tables.
Rollback application code preserves source/version history.

## Supported bundles and limits

`skill.json` may supply canonical Skillplane metadata. Otherwise `SKILL.md` needs
YAML frontmatter with text `name` and `description`; the importer derives the slug
from the name. YAML aliases and duplicate keys are rejected. Shared bundle
validation applies to formats, paths, file inventory, and size. Alongside existing
bundle roots, imports preserve common `LICENSE`, `LICENSE.txt`, `README.md`,
`templates/`, and `agents/` files. This extends the shared bundle path allowlist
without changing existing canonical digests.

Imports only contact the fixed GitHub REST API host, do not follow redirects, and
verify Git blob hashes. They never clone repositories or execute source code.
Reject symlinks, submodules, traversal, unsupported entries, detected private keys
and token patterns, truncated trees, trees over 10,000 entries, more than 32 skills,
more than 200 requests, blobs over 5 MiB, snapshots over 20 MiB expanded, and
fetches exceeding 90 seconds. Individual malformed skills remain explicit errors.
Credential detection is a bounded check for known patterns, not a complete secret
scanner; only public repositories are accepted and source bytes remain private.

Private Git credentials, webhooks, automatic schedules, and non-GitHub providers
are later extensions. No credentials or repository contents are stored in source
configuration or preview records.

## API

Under `/api/v1/workspaces/:workspaceId/sources`:

- `GET` lists sources (50 per page, `cursor`); `POST` creates with an idempotency key.
- `GET /:sourceId` returns source, bindings, and the latest 20 runs.
- `PATCH /:sourceId` changes ref/policy/archive with `expectedRevision`.
- `POST /:sourceId/bindings` explicitly binds `path` and `skillId`; `DELETE` disconnects `path`.
- `POST /:sourceId/preview` creates a plan; `POST /:sourceId/apply` confirms `runId`.

Workspace members may read; owner/admin human sessions may write. Existing CSRF
and workspace routing guards apply. Version provenance is available at
`/api/v1/workspaces/:workspaceId/skills/:skillId/versions/:versionId/source`.
