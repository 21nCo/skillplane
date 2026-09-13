# Tagged releases

Skillplane has two independent tag namespaces. Both workflows require the tag
to exist and point to a commit already contained in `origin/main`.

| Tag                            | Result                                                                                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `skillplane-v0.1.0`            | Verify, pack, smoke-install, and publish the public `skillplane@0.1.0` package to npm                                                       |
| `skillplane-cloudflare-v0.1.0` | Back up and migrate the production topology, deploy the app/MCP/projection Workers, run production smoke checks, and deploy the docs Worker |

The CLI tag version must exactly match `packages/local-runtime/package.json`.
Stable versions publish to npm's `latest` dist-tag; prerelease versions publish
to `next` and never replace `latest`.
The Cloudflare version is a release identifier and is recorded as the Wrangler
deployment tag through `SKILLPLANE_RELEASE_TAG`.

## GitHub configuration

Create a protected GitHub environment named `production` and require deployment
reviewers. Both the npm publication job and the Cloudflare deployment job use
this approval boundary before credentials become available.

Create repository tag rulesets for `skillplane-v*` and
`skillplane-cloudflare-v*`. Restrict tag creation, updates, and deletion to the
intended release principals; do not permit force-updating either release
namespace. Configure these
environment variables:

- `PRODUCTION_RELEASES_ENABLED=true` (set only after reviewers and tag rulesets
  are active; both workflows fail closed when it is absent)
- `CLOUDFLARE_ACCOUNT_ID`
- `CLOUDFLARE_CONTROL_HYPERDRIVE_ID`
- `SKILLPLANE_CELL_IN_SOUTH_HYPERDRIVE_ID`
- `SKILLPLANE_CELL_US_EAST_HYPERDRIVE_ID`
- `SKILLPLANE_PUBLIC_BUCKET`
- `SKILLPLANE_CELL_IN_SOUTH_BUCKET`
- `SKILLPLANE_CELL_US_EAST_BUCKET`
- `PUBLIC_TURNSTILE_SITE_KEY`

Configure these environment secrets:

- `CLOUDFLARE_API_TOKEN`
- `SKILLPLANE_PRODUCTION_DATABASE_URL`
- `SKILLPLANE_CELL_IN_SOUTH_DATABASE_URL`
- `SKILLPLANE_CELL_US_EAST_DATABASE_URL`
- `SKILLPLANE_BACKUP_ENCRYPTION_KEY`
- `SKILLPLANE_R2_ACCESS_KEY_ID`
- `SKILLPLANE_R2_SECRET_ACCESS_KEY`
- `AUTHFN_SECRET`
- `OAUTH_TOKEN_PEPPER`
- `TURNSTILE_SECRET_KEY`
- `POSTHOG_PROJECT_TOKEN`
- `WORKSPACE_ROUTING_KEYS`

The workflow intentionally uses `SKILLPLANE_PRODUCTION_DATABASE_URL` as both
the canonical production URL and the control-plane URL, matching the topology
deployment invariant. `WORKSPACE_ROUTING_KEYS` is the complete JSON keyring
required by `deployment/topology.production.json`.

Grant this repository access to the organization secret `NPM_TOKEN` for CLI
publication. Only the approved publication job requests an OIDC token so npm
can attach build provenance.

## Creating a release

Update and validate the target version before creating a tag. For example:

```bash
pnpm cli:release:check
git tag skillplane-v0.1.0
git push origin skillplane-v0.1.0
```

For a Cloudflare release, first ensure the tagged commit's migrations and
topology manifest are production-ready:

```bash
pnpm deploy:check
git tag skillplane-cloudflare-v0.1.0
git push origin skillplane-cloudflare-v0.1.0
```

The Cloudflare workflow keeps every production release run. A credential-free
queue job waits until all earlier active runs of the same workflow finish, so a
newer tag cannot replace an already-pending release. GitHub job re-runs are
rejected because they retain the old queue position; retry a release with a new
`workflow_dispatch` run instead. Before any migration, the workflow compares
the requested tag with both the active app Worker and a durable GitHub
deployment ledger. It records the accepted version in that ledger immediately
before migration, so a partial release cannot later be superseded by an older
tag. Production rollback remains the separate, explicit procedure in
[`rollback.md`](./rollback.md). The deployment then enters the protected
`production` environment and runs the established blocking sequence:

```text
deploy:check
db:migrate:topology
deploy:all
smoke:production:release
deploy:docs
```

`deploy:all` keeps the existing dependency-safe Worker ordering and performs
its own release smoke before returning. The explicit smoke step remains as the
final app/MCP check before docs deployment. Encrypted topology backups and
migration state are retained as a private workflow artifact for 30 days,
including when a later step fails.

The apex landing Worker at `skillplane.dev` remains excluded because it is
owned and released from the 21n monorepo's `landing/skillplane` workspace.

Both workflows may be retried manually with `workflow_dispatch`, but the input
must name an existing tag. Manual runs check out the tag itself; they do not
publish or deploy the default branch by accident. For Cloudflare, the tag must
be at least as new as the active or previously accepted production release.
The first tagged release over an existing legacy deployment may use the
protected `allow_legacy_bootstrap` input after reviewers verify that deployment's
provenance. With a nonempty ledger, the override accepts only an exact retry of
the recorded high-water tag. If the first bootstrap stops after recording that
tag but before replacing the legacy Worker, a fresh protected dispatch of the
same tag may use the override again; it cannot advance while the active Worker
remains unrecognized.

The npm workflow preserves every `skillplane` release in an explicit FIFO queue,
checks the target channel's current registry version before building and again
immediately after production approval, rejects version downgrades, and treats an
exact already-published version as an idempotent retry. GitHub job re-runs are
rejected at every package release stage; retry the existing tag with a fresh
`workflow_dispatch` run. Each queue reads all workflow runs once per poll and
filters active states locally, so status transitions cannot disappear between
separate API queries. Both FIFO queues use GitHub's maximum six-hour job window
and exponentially back off API polling to a ten-minute interval. If an earlier
release remains active beyond that window, retry the timed-out tag with a fresh
dispatch after the blocker settles.
