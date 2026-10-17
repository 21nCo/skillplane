# Git skill sources

Workspace owners and admins can connect **public GitHub repositories** from
**Git sources**. A source imports either all discovered `SKILL.md` directories or
one repository-relative `SKILL.md` path or directory (including an empty
directory for repository root). File paths are normalized to their containing
skill directory before storing configuration and provenance. No particular parent folder name is required. Choose a tracked branch/tag
for manual updates, or pin a full 40-character commit SHA. Repository and path
scope stay fixed after creation; archive a source and create another to change
scope. Ref policy and ref can be edited with an expected revision.

## Preview and apply

Preview resolves a ref to an immutable commit and stores a bounded plan. Apply
requires that exact run ID, fetches the pinned commit again, verifies content,
and rejects stale source revisions. Each item reports added, changed, unchanged,
missing, conflict, or invalid content. New skills are **private** and use the
existing initial-publication flow. Apply creates entries in path order, so a
format-v2 skill may depend on a skill added earlier in the same sync; dependency
resolution errors are reported by apply and remain retryable. Changes to an existing skill create a
`pending_review` version through the normal version service. Owners/admins review
and publish or reject those versions in the existing version UI.

Bindings are explicit. A matching manual skill slug reports a conflict until the
owner chooses **Bind an existing workspace skill**; imports never silently attach
manual skills. When several source paths declare one slug, every one of them is
a conflict. Binding paths may name the skill directory or its `SKILL.md`; both
store the directory. Changed published heads, archived targets, renamed slugs, and
rejected imported candidates require review; if upstream later returns to the
published head, the binding converges to it as unchanged. A pending imported
candidate is never duplicated: upstream content identical to a pending candidate
imported from the same path binds that candidate (unchanged, awaiting review), and
upstream returning to the published head while a candidate is pending keeps the
binding `pending_review` on that candidate with an explicit message. Missing/renamed source
paths retain the existing skill and history. An active binding is never moved to
another skill: a path that became bound after preview is a conflict. A source binds
at most 32 skills (missing paths count until disconnected); additions beyond that
are conflicts and create nothing. Disconnect a binding to resolve a rename or attach the skill to a different source;
this retains its versions, provenance, and the disconnected mapping, which stays
listed even after the path is bound to another skill. Archive stops
sync but preserves bindings,
runs, versions, and provenance. Restoring permits another preview.

Repeated content creates no version, even when the commit changes. Apply retries
reuse the same run and per-item idempotency keys; version and Git provenance commit
atomically. A retry also recovers a committed version whose binding/result write
failed. A bounded, renewable database lease serializes sync for each source and
prevents settings/binding edits while it runs. Version/provenance commits and
binding/run mutations validate lease ownership, expiry, and source revision under
a database row lock; a stalled worker cannot resume after expiry or takeover.
Apply rechecks review decisions before recording unchanged content or recovering a
previously committed candidate. Starting an apply advances the source revision,
so any other preview of that source becomes stale; only the same run may resume
while nothing else changed. A new preview is required to apply corrected content
at another commit.

Format-v2 skills gain a server-generated dependency lock, so a plan entry that
preview could prepare (changed, unchanged against the published head, or reuse of
a pending candidate) stores its `preparedDigest` beside the raw repository
`digest`. Apply prepares the bundle again and imports, reuses or converges only
when that digest still matches; a dependency published in between fails the entry
with "Preview content changed; preview again" and creates nothing. Additions resolve
their lock at apply.

Provider errors are classified by request stage. A repository, branch, tag or
commit that GitHub reports missing (404 or 422) while resolving the ref, or the
pinned preview commit at apply, is a permanent `VALIDATION_FAILED` (400) error.
Once the commit resolved, a failed tree or blob request aborts the whole snapshot
as a retryable `SERVICE_UNAVAILABLE` (503), never a partial plan with invalid
skills; network failures, throttling (403/429) and server errors are 503 too.

## Provenance and storage

Each imported version records repository URL, resolved commit SHA, directory,
canonical bundle digest, source/run IDs, and import timestamp. The database rejects
provenance updates and edits to stored preview identity/plan. Binding version
references must name existing versions of the same workspace, and provenance must
name a run of its own source. Version overview and
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
verify Git blob hashes. Refs resolve to a bare commit SHA, so large upstream
diffs never count toward import limits. Only entries inside a selected skill
directory are fetched or validated; other repository files are ignored. Inside a
skill, paths follow bundle rules, and paths that collide after Unicode
normalization or case folding make that skill invalid. They never clone repositories or execute source code.
Reject symlinks, submodules, traversal, unsupported entries, detected private keys
and token patterns, truncated trees, trees over 10,000 entries, more than 32 skills,
more than 200 requests, skills with more than 197 distinct blob IDs (identical
files share one blob; the 200-request budget is shared by every skill in the
snapshot, so a repository-wide source can reach it sooner), blobs over 5 MiB,
snapshots over 20 MiB expanded, and fetches exceeding 90 seconds. Individual malformed skills remain explicit errors.
Credential detection is a bounded check for known patterns, not a complete secret
scanner; only public repositories are accepted and source bytes remain private.

Private Git credentials, webhooks, automatic schedules, and non-GitHub providers
are later extensions. No credentials or repository contents are stored in source
configuration or preview records.

## API

Under `/api/v1/workspaces/:workspaceId/sources`:

- `GET` lists sources (50 per page, `cursor`); `POST` creates with an idempotency key.
- `GET /:sourceId` returns source, active and disconnected bindings, and the latest 20 runs.
- `PATCH /:sourceId` replaces ref/policy/archive configuration. Include `repositoryUrl`, `path`, `archived`, and `expectedRevision`, plus the existing `ref` and `refPolicy` values to retain them.
- `POST /:sourceId/bindings` explicitly binds `path` and `skillId` (JSON body `{ "path", "skillId" }`); `DELETE` disconnects the path given in the JSON body `{ "path": "skills/review" }`.
- `POST /:sourceId/preview` creates a plan; `POST /:sourceId/apply` confirms `runId`.

Workspace members may read; owner/admin human sessions may write. Existing CSRF
and workspace routing guards apply. Version provenance is available at
`/api/v1/workspaces/:workspaceId/skills/:skillId/versions/:versionId/source`.
