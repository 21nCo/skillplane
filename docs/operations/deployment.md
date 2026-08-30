# Production deployment

For the global-control/regional-cell ownership model, routing assertions,
failure behavior, workspace moves, outages, and key rotation, see
[`global-control-plane.md`](./global-control-plane.md). The topology manifest
must be validated and every private cell deployed before enabling gateway mode.

The checked-in transition deployment still deploys the single-cell Skillplane
app and MCP Workers backed by one PostgreSQL database and one private R2 bucket.
The multi-cell renderer in `scripts/lib/topology-deployment.mjs` generates the
next-stage canonical app/MCP gateways plus private app/MCP workers for every
cell in `deployment/topology.production.json`. It requires separate control and
cell Hyperdrive IDs and separate public/regional bucket names. Generated cell
workers have no route, no `workers.dev` exposure, no downstream service
bindings, and no Email Service binding. Promotion of those generated configs is
an explicit rollout step after the cells and projection drainer are provisioned;
it is not an automatic side effect of the legacy `deploy:all` command.

The
landing Worker is maintained and deployed independently from the 21n monorepo's
`landing/skillplane` workspace. The production hosts are
`skillplane.dev`, `app.skillplane.dev`, `mcp.skillplane.dev`, and the PostHog
reverse proxy at `user.skillplane.dev`.

## One-time provider preparation

Before the first release:

1. Create a password-authenticated production PostgreSQL database reachable over
   TLS, enable the provider's managed backup and point-in-time recovery policy,
   and retain its direct URL for migration and backup processes only.
2. Create a Cloudflare Hyperdrive configuration whose origin is that PostgreSQL
   database. Record its 32-character ID. Do not put the direct database URL into
   a Worker variable.
3. Create a production Turnstile widget restricted to
   `app.skillplane.dev`. Record its site key and secret key.
4. Complete Cloudflare Email Service onboarding for `skillplane.dev`, including
   the sender `no-reply@auth.skillplane.dev`, and confirm arbitrary-recipient
   transactional sending is enabled.
5. Create the PostHog managed reverse proxy for `user.skillplane.dev` by
   following the [PostHog reverse-proxy guide](https://posthog.com/docs/advanced/proxy).
   Point an unproxied DNS-only CNAME at the PostHog-provided proxy target and
   wait until PostHog reports the proxy as live.
6. Confirm the Wrangler identity has Workers Scripts, Workers Routes,
   Hyperdrive read, R2 read/write, and Email Sending permissions. The zone must
   be active in the same Cloudflare account.

`pnpm deploy:all` creates `skillplane-skill-bundles` only when it is absent. If
the bucket has no lifecycle action, it adds only a seven-day incomplete
multipart upload abort rule. It then refuses deployment if the bucket has an
object-expiration or storage transition rule, an enabled `r2.dev` URL, or a
custom domain. Published skill bundles never receive age-based deletion.

## Required process inputs

Supply secrets from a password manager or CI secret store. Do not source an
untrusted shell file and do not commit values.

For a controlled local release, place the long-lived values in the ignored
`.env.production.local` file and set its mode to `0600`. Production package
commands ask Node to parse that file without executing it. Existing process
environment variables take precedence. Keep short-lived OTP, Turnstile, and
OAuth verification values in the invoking process when practical, and remove
them immediately after their gate.

Run `pnpm production:secrets:init` once to generate strong independent
`AUTHFN_SECRET`, `OAUTH_TOKEN_PEPPER`, and
`SKILLPLANE_BACKUP_ENCRYPTION_KEY` values directly into that file. The command
does not print values, rejects duplicate or weak existing assignments, refuses
symlinks, and enforces mode `0600`.

Supply the existing `POSTHOG_PROJECT_TOKEN` separately; the initializer does
not generate credentials for external services. The renderer exposes that
project token to the browser as `PUBLIC_POSTHOG_KEY` and supplies it to the MCP
Worker as a secret.

| Variable                                              | Purpose                                                                 |
| ----------------------------------------------------- | ----------------------------------------------------------------------- |
| `SKILLPLANE_PRODUCTION_DATABASE_URL`                  | Direct PostgreSQL URL used only by backup, migration, and verification  |
| `SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL` | Temporary old-production URL used only by `db:move:production`          |
| `CLOUDFLARE_HYPERDRIVE_ID`                            | Existing cache-disabled Hyperdrive configuration bound to `HYPERDRIVE`  |
| `SKILLPLANE_BACKUP_ENCRYPTION_KEY`                    | At least 32 characters; encrypts logical backups before they reach disk |
| `AUTHFN_SECRET`                                       | AuthFn signing and tenancy secret, at least 32 characters               |
| `OAUTH_TOKEN_PEPPER`                                  | OAuth token hashing pepper, at least 32 characters                      |
| `POSTHOG_PROJECT_TOKEN`                               | Existing PostHog project token used by browser and MCP analytics        |
| `POSTHOG_HOST`                                        | Optional local MCP override; production uses the canonical US host      |
| `TURNSTILE_SECRET_KEY`                                | Production Turnstile secret, at least 32 characters                     |
| `PUBLIC_TURNSTILE_SITE_KEY`                           | Public site key for the production widget                               |
| `SKILLPLANE_RELEASE_TAG`                              | Optional stable release label; generated when omitted                   |

The one-time multi-cell conversion additionally requires
`SKILLPLANE_CONTROL_DATABASE_URL`, one
`SKILLPLANE_CELL_<REGION>_DATABASE_URL` and
`SKILLPLANE_CELL_<REGION>_BUCKET` per manifest cell, and the public bucket in
`SKILLPLANE_PUBLIC_BUCKET`. `SKILLPLANE_LEGACY_BUCKET` defaults to the legacy
`skillplane-skill-bundles` bucket when omitted. Control and cell database URLs
must all be distinct.

The direct URL may use any PostgreSQL provider, but it must include a host,
username, password, and database name. `sslmode` defaults to `require`; only
`require`, `verify-ca`, and `verify-full` are accepted. The controlled
`insouth.db.21n.dev` alias retains its libpq-compatible TLS behavior. Both backup
and migration query `pg_stat_ssl` and fail if the connection is not encrypted.
Provider URLs using PostgreSQL 17's `sslrootcert=system` hint are normalized for
`node-postgres`, which uses Node's trusted CA set while retaining `verify-full`.
TLS evidence accepts either a certificate-authorized client socket or the
server's `pg_stat_ssl` confirmation, so providers that terminate TLS at a
PostgreSQL proxy remain verifiable without weakening transport security.

`RAILWAY_DATABASE_URL` remains a temporary compatibility alias. New setups must
use `SKILLPLANE_PRODUCTION_DATABASE_URL`; if both are present they must resolve
to the same database identity.

The production Hyperdrive configuration must have SQL response caching disabled.
Skillplane is an authorization and mutation control plane, so stale cached reads
can violate permission checks and read-after-write guarantees. Deployment checks
the live configuration and stops before upload if query caching is enabled.

The complete Skillplane source must also be committed with a clean worktree.
The application commit and a digest of all runtime, deployment, package, and
script sources are written to the release manifest. Deployment refuses
untracked or modified source.

## Move production to a new PostgreSQL origin

Keep both raw URLs only for the duration of the move:

```dotenv
SKILLPLANE_PRODUCTION_DATABASE_URL=postgresql://new-production...
SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL=postgresql://old-production...
```

Freeze writes to the source, ensure the target is empty, and run with the exact
source and target database names as destructive confirmations:

```bash
pnpm db:move:production -- \
  --confirm-source-write-frozen <old-database-name> \
  --confirm-empty-database <new-database-name>
```

The command creates and verifies an encrypted source backup, restores it into
the empty target, creates a fresh pre-migration target backup, then applies and
verifies current migrations and writes the safety records required by
`deploy:all`. It does not deploy Workers or move traffic. Remove
`SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL` after the cutover is
accepted.

## Release sequence

Run the blocking app/MCP release sequence from the repository root:

```bash
pnpm deploy:check
pnpm db:backup:production
pnpm db:migrate:production
pnpm deploy:all
pnpm smoke:production:release
```

`deploy:all` already runs `smoke:production:release` before it writes the
release manifest. The explicit invocation above is the final operator-visible
verification of the recorded app/MCP pair.

Run the cross-system topology check separately before and after the release, or
from the landing deployment's own operational workflow:

```bash
pnpm smoke:production:topology
```

That check adds the independently deployed `skillplane.dev` landing Worker,
including its TLS, caching, immutable assets, and shared icon contract. A
landing failure is an environment incident that must be escalated to the
landing owner, but it does not invalidate or prevent recording a healthy
app/MCP deployment that this repository can roll back.

For the first conversion from the combined database, take and verify the
backup, provision every empty cell database and private bucket, render the
topology, and run `pnpm db:migrate:topology` before deploying any gateway. The
command is resumable and deliberately ordered: it initializes cells, upgrades
the combined source without pruning it, enables a database write fence, runs a
rollback drill plus row/bundle checksum verification for every workspace,
copies and digest-verifies every existing public release into the global
public bucket, marks placements active in the first declared cell, and only
then drops regional tables from the control database. A failure leaves the
source regional tables intact and the durable cutover state at `copying`; fix
the cause and rerun the same command. Do not deploy gateway mode unless the
command returns a completed cutover and the normal smoke gates pass.

The commands enforce these boundaries:

- `db:backup:production` performs `pg_dump --format=custom`, encrypts the
  archive with AES-256-GCM and a scrypt-derived key, verifies decryption, and
  proves `pg_restore --list` can read it. Its Postgres client image matches the
  PostgreSQL server major version, and no plaintext dump is written.
- `db:migrate:production` applies committed migrations directly to PostgreSQL,
  verifies every migration hash, table, constraint, trigger, and required query
  plan, records the exact application Git commit, and never uses Hyperdrive.
- `deploy:all` refuses to start unless the matching backup is less than 24
  hours old, verified migration state is less than two hours old, and that
  migration was produced from the exact application commit being deployed.
  This commit lock is required for forward-only compatibility changes such as
  the workspace-sharded public statistics counter in migration 0019; do not
  canary or roll back an older app binary against that migrated schema. Deploy
  a compatible forward maintenance release instead. The command renders ignored
  `wrangler.generated.json` files only after validating the real Hyperdrive ID.
  Before the first Cloudflare mutation, it reads that configuration back from
  Cloudflare and requires its origin host, port, and database to exactly match
  `SKILLPLANE_PRODUCTION_DATABASE_URL`. The Hyperdrive origin may use a separate
  least-privilege database role.
- Worker secrets are written to a mode-`0600` temporary JSON file, supplied to
  `wrangler deploy --secrets-file`, and deleted in a `finally` block. They are
  never written to Wrangler source configuration or `.conduct`. The app
  receives AuthFn, OAuth, and Turnstile secrets; MCP receives the OAuth pepper
  and PostHog project token. The app also receives the public PostHog project
  key and `https://user.skillplane.dev` proxy host as non-secret variables.
  The browser SDK keeps `https://us.posthog.com` as its UI host, as required by
  PostHog. MCP traffic does not use the browser proxy and receives the canonical
  PostHog ingestion host as a non-secret variable. MCP does not receive Email
  Service or Turnstile bindings.
- Deployment order is app, then MCP. On a first deployment, each Worker receives
  an identical rollback baseline followed by a distinct release version.
- The blocking release smoke and rollback rehearsal cover only the app and MCP
  Workers that this repository deploys and can restore. The separate topology
  smoke covers the landing, app, and MCP public surfaces without becoming a
  release-manifest dependency.
- The app and MCP Workers use Custom Domains with `workers_dev: false`. The
  independently deployed landing Worker uses the proxied zone route
  `skillplane.dev/*` because the apex has an externally managed DNS origin record
  that Cloudflare Custom Domains will not replace. The route covers every apex
  request at the edge while preserving the existing DNS record.

The successful command writes a sanitized, append-only manifest under
`.conduct/deployments/`. It records Worker release/prior versions, Hyperdrive
ID, R2 policy, lock/config digests, migration and backup identifiers, the host
inventory, and app/MCP release-smoke results. Listing the landing host describes
the production topology; it does not claim that `deploy:all` deployed or
validated the landing Worker. The manifest records secret names only.

## Live OAuth, MCP, and email gates

The McpFn ownership boundary, automated gates, controlled Claude and ChatGPT
proof, artifact rules, and paired app/MCP rollback contract are documented in
[`mcpfn.md`](./mcpfn.md).

Create or sign in to the controlled production account, create a workspace, and
complete an OAuth authorization-code flow for the exact resource
`https://mcp.skillplane.dev/mcp`. Then provide:

- `SKILLPLANE_PRODUCTION_MCP_ACCESS_TOKEN`
- `SKILLPLANE_PRODUCTION_WORKSPACE_ID`
- `SKILLPLANE_PRODUCTION_AGENT_ID`
- `SKILLPLANE_PRODUCTION_AGENT_NAME`
- `SKILLPLANE_PRODUCTION_MODEL_PROVIDER`
- `SKILLPLANE_PRODUCTION_MODEL_NAME`
- `SKILLPLANE_PRODUCTION_MODEL_VERSION`

Run:

```bash
pnpm test:mcp:production
```

The gate rejects service-principal credentials. It negotiates Streamable HTTP,
checks all nine tool contracts, and executes `skills_search`. Successful
execution proves the OAuth token was accepted for the production MCP resource
audience. Caller metadata is audited while user identity is derived only from
the verified token.

For email, use the real production sign-in page with a controlled recipient,
enter the received OTP, then set only
`SKILLPLANE_PRODUCTION_OTP_RECIPIENT` and run:

```bash
pnpm verify:email:production
```

The gate uses the SSL-protected direct PostgreSQL audit connection to prove a
recent Cloudflare Email Service challenge has a provider message ID, was
consumed, and created an active email-OTP session. It persists only hashes.

An alternative CLI-assisted flow accepts a short-lived
`SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN`. The first run sends and exits pending;
set `SKILLPLANE_PRODUCTION_OTP_CODE` to the received code and rerun within ten
minutes. Neither value is persisted.

Finish with:

```bash
pnpm verify:rollback:production
```

Do not accept production traffic until every command passes and the provider
dashboards show healthy database-provider backups, Cloudflare Email Service onboarding,
both application Custom Domains as active, and the PostHog proxy as live. In the
browser network panel, trigger an explicit product event, confirm its request to
`user.skillplane.dev` returns `200`, and confirm the event appears in PostHog.
Verify the independently managed landing zone route from its own workspace.
The repository-level `pnpm smoke:production:topology` command may be used as a
cross-system confirmation, but landing repair and rollback remain owned by that
workspace.

## Failure handling

- A missing or malformed Hyperdrive ID fails before any generated config or
  Cloudflare mutation. A well-formed ID for an absent or different origin also
  fails before R2 or Worker mutation.
- A backup, SSL, migration, or schema verification failure stops before
  deployment.
- A partial Worker deployment leaves
  `.data/production/release-in-progress.json` with sanitized completed-version
  state. Inspect it and active Cloudflare deployments before retrying.
- A failing `smoke:production:topology` with a passing
  `smoke:production:release` identifies an independently owned landing or
  cross-origin consistency incident; do not treat it as evidence that the
  recorded app/MCP versions failed to deploy.
- Never select another account's Hyperdrive configuration by position or infer
  an ID from unrelated resources.
- Never retry a deployment by bypassing `--strict`, changing the canonical
  domains, publishing R2, or placing a direct PostgreSQL URL in Worker vars.
