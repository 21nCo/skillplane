# Git skill sources

Workspace owners and admins can connect **public GitHub repositories**, and
private ones through a connected GitHub App installation, from **Git sources**. A source imports either all discovered `SKILL.md` directories or
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
Redirects are never followed: a redirected ref resolution (a moved or renamed
repository) is a 400 asking for the repository's current URL, and a redirected
tree or blob request aborts the snapshot with a 503.

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
scanner; private repositories are read only through a bound GitHub App
installation, and source bytes remain private.

Webhooks, automatic schedules, and non-GitHub providers are later extensions.
No credentials or repository contents are stored in source configuration or
preview records.

## GitHub App authentication

Private repositories are read through the Skillplane GitHub App. A workspace
owner or admin connects it from **Settings → GitHub** (see
[Connecting GitHub](#connecting-github)); a source created with one of the
workspace's active installations reads its repository with installation
tokens, and every other source is still read anonymously as a public
repository. Personal access tokens are not supported.

The primitives are:

- The Worker secret names in `GITHUB_APP_SECRET_NAMES` (`@skillplane/config`).
  They are set with `wrangler secret put`, never as `vars`, in a committed
  Wrangler file or in the database:

  | Secret                      | Value                                                       |
  | --------------------------- | ----------------------------------------------------------- |
  | `GITHUB_APP_ID`             | The App ID (or client ID) used as the App JWT issuer        |
  | `GITHUB_APP_PRIVATE_KEY`    | The App private key PEM; escaped `\n` newlines are accepted |
  | `GITHUB_APP_WEBHOOK_SECRET` | The webhook signing secret, at least 32 characters          |

- A short-lived RS256 App JWT and installation tokens limited to the source's
  repository with `contents: read` (writes use a separate `contents: write`
  token). A token GitHub returns with any other permission (other than the
  implicit `metadata: read`) or another repository set is refused as
  `auth_failed` and never cached. A token is reused until five minutes before
  it expires and then dropped from Worker memory; the cache keeps at most 256
  scopes, dropping the least recently used. Tokens never appear in errors,
  logs or audit rows.
- An authenticated source provider with the same snapshot interface as the
  public one, plus write primitives (create blob, tree and commit, and move a
  branch). Branch writes use the GraphQL `updateRefs` mutation with the
  expected commit as `beforeOid`, so any concurrent move, including a reset to
  an older commit, is refused as `stale_ref`.
- Classification of a removed, suspended or wrongly scoped installation as
  `GIT_SOURCE_AUTH_FAILED` (`reason: auth_failed`). A 404 is `auth_failed` only
  when the repository itself is no longer visible to the installation; a
  missing ref or object in a visible repository is not. GitHub rate limits,
  including secondary limits reported without rate limit headers, a refusal
  whose body cannot be read and a token refusal that does not name the
  repository or permission, are retryable outages.

When a preview or apply fails with `auth_failed`, the source, its runs,
bindings and versions are kept, and one `skill_source.auth_failed` audit event
(outcome `error`, metadata `reason: auth_failed`) is written for the source.
Unbinding an installation writes the same event for every source that reads
through it. Reading the source (get and list) then reports
`authStatus: auth_failed` until the next preview or apply that completes,
including an apply that finishes as `partial` because some skills failed,
which sets it back to `ok`. A source whose installation is unbound, or
removed or suspended on GitHub, fails its preview and apply with
`auth_failed` without contacting GitHub.

## Connecting GitHub

Owners and admins choose **Connect GitHub** in **Settings → GitHub**. Skillplane
redirects to the App's install page with a signed `state` bound to the
workspace and user; it expires after ten minutes and is accepted once. GitHub
returns the browser to the App's callback URL, `/github/setup`, where
Skillplane:

1. verifies the state's signature and expiry and that the signed-in user is the
   one it was issued to and is still an owner or admin of its workspace;
2. records the state as used, so a replayed callback is refused;
3. exchanges GitHub's user authorization `code` and checks that the
   installation is listed in that user's `GET /user/installations`, so an
   `installation_id` the user cannot access on GitHub is refused;
4. fetches the installation with the App JWT and checks its account; and
5. binds it to the workspace. An installation bound to another workspace is
   refused, including when two workspaces bind it at the same moment.

Every outcome returns to **Settings → GitHub** with a `github_connected` or
`github_error` code. Members see the installations read-only.

Listing installations checks each one with GitHub, so an installation
uninstalled or suspended on GitHub shows as such (webhook updates are a later
extension). **Disconnect** unbinds the installation from the workspace only:
the App stays installed on GitHub, and sources that read through it are kept
and marked `auth_failed` until it is connected again. **Add source** offers the
repositories of each active installation; the repository must belong to the
installation's account.

The installation binding is unique per regional database. Two workspaces in
different regional cells are not prevented from binding the same
installation.

### App and deployment settings

Enable **Request user authorization (OAuth) during installation** on the App
and set its callback URL to `https://<app host>/github/setup`. Besides the
Worker secrets below, set:

| Setting                    | Value                                                 |
| -------------------------- | ----------------------------------------------------- |
| `GITHUB_APP_SLUG`          | The App's URL name (`https://github.com/apps/<slug>`) |
| `GITHUB_APP_CLIENT_ID`     | The App's client ID                                   |
| `GITHUB_APP_CLIENT_SECRET` | The App's client secret (a Worker secret)             |

`GITHUB_API_URL` and `GITHUB_WEB_URL` point at a fake GitHub in tests and are
accepted only when `RUNTIME_ENV` is `local`. Apply migration
`0056_regional_github_installations.sql` (tables `github_installations` and
`github_installation_states`, and `skill_sources.github_installation_id`) to
regional and combined databases before running this application.

## API

Under `/api/v1/workspaces/:workspaceId/sources`:

- `GET` lists sources (50 per page, `cursor`); `POST` creates with an idempotency key.
- `GET /:sourceId` returns source, active and disconnected bindings, and the latest 20 runs.
- `PATCH /:sourceId` replaces ref/policy/archive configuration. Include `repositoryUrl`, `path`, `archived`, and `expectedRevision`, plus the existing `ref` and `refPolicy` values to retain them.
- `POST /:sourceId/bindings` explicitly binds `path` and `skillId` (JSON body `{ "path", "skillId" }`); `DELETE` disconnects the path given in the JSON body `{ "path": "skills/review" }`.
- `POST /:sourceId/preview` creates a plan; `POST /:sourceId/apply` confirms `runId`.
- `POST` accepts an optional `installationId` to read a private repository
  through an active installation bound to the workspace.

Under `/api/v1/workspaces/:workspaceId/github`:

- `GET /install` redirects an owner or admin to the App install page.
- `GET /installations` lists installations with their status (`active`,
  `suspended` or `removed`); `DELETE /installations/:installationId` unbinds one.
- `GET /installations/:installationId/repositories` lists the repositories an
  active installation grants.

Workspace members may read; owner/admin human sessions may write. Existing CSRF
and workspace routing guards apply. Version provenance is available at
`/api/v1/workspaces/:workspaceId/skills/:skillId/versions/:versionId/source`.
