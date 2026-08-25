# Production deployment

This repository deploys the Skillplane app and MCP Cloudflare Workers backed by
one Railway Postgres database through Hyperdrive and one private R2 bucket. The
landing Worker is maintained and deployed independently from the 21n monorepo's
`landing/skillplane` workspace. The production hosts are
`skillplane.dev`, `app.skillplane.dev`, `mcp.skillplane.dev`, and the PostHog
reverse proxy at `user.skillplane.dev`.

## One-time provider preparation

Before the first release:

1. Create the production Railway Postgres service, enable its managed backup
   policy, and retain its public TCP-proxy URL or the explicitly approved
   `insouth.db.21n.dev` Railway alias for migration and backup processes only.
2. Create a Cloudflare Hyperdrive configuration whose origin is that Railway
   database. Record its 32-character ID. Do not put the Railway URL into a
   Worker variable.
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

| Variable                           | Purpose                                                                             |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| `RAILWAY_DATABASE_URL`             | Direct Railway public Postgres URL used only by backup, migration, and verification |
| `CLOUDFLARE_HYPERDRIVE_ID`         | Existing cache-disabled Hyperdrive configuration bound to `HYPERDRIVE`              |
| `SKILLPLANE_BACKUP_ENCRYPTION_KEY` | At least 32 characters; encrypts logical backups before they reach disk             |
| `AUTHFN_SECRET`                    | AuthFn signing and tenancy secret, at least 32 characters                           |
| `OAUTH_TOKEN_PEPPER`               | OAuth token hashing pepper, at least 32 characters                                  |
| `POSTHOG_PROJECT_TOKEN`            | Existing PostHog project token used by browser and MCP analytics                    |
| `POSTHOG_HOST`                     | Optional local MCP override; production uses the canonical US ingestion host        |
| `TURNSTILE_SECRET_KEY`             | Production Turnstile secret, at least 32 characters                                 |
| `PUBLIC_TURNSTILE_SITE_KEY`        | Public site key for the production widget                                           |
| `SKILLPLANE_RELEASE_TAG`           | Optional stable release label; generated when omitted                               |

The Railway URL must use a Railway TCP-proxy hostname or the exact controlled
alias `insouth.db.21n.dev`; arbitrary aliases remain rejected. The connection is
forced to `sslmode=require`. Because the approved alias presents the Railway
self-signed PostgreSQL certificate chain, node-postgres uses explicit
libpq-compatible `require` semantics for that alias. Both backup and migration
query `pg_stat_ssl` and fail if the connection is not encrypted.

The production Hyperdrive configuration must have SQL response caching disabled.
Skillplane is an authorization and mutation control plane, so stale cached reads
can violate permission checks and read-after-write guarantees. Deployment checks
the live configuration and stops before upload if query caching is enabled.

The complete Skillplane source must also be committed with a clean worktree.
The application commit and a digest of all runtime, deployment, package, and
script sources are written to the release manifest. Deployment refuses
untracked or modified source.

## Release sequence

Run from the repository root:

```bash
pnpm deploy:check
pnpm db:backup:production
pnpm db:migrate:production
pnpm deploy:all
pnpm smoke:production
```

The commands enforce these boundaries:

- `db:backup:production` performs `pg_dump --format=custom`, encrypts the
  archive with AES-256-GCM and a scrypt-derived key, verifies decryption, and
  proves `pg_restore --list` can read it. Its Postgres client image matches the
  Railway server major version, and no plaintext dump is written.
- `db:migrate:production` applies committed migrations directly to Railway,
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
  Cloudflare and requires its origin host, port, database, and user to exactly
  match `RAILWAY_DATABASE_URL`.
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
- The app and MCP Workers use Custom Domains with `workers_dev: false`. The
  independently deployed landing Worker uses the proxied zone route
  `skillplane.dev/*` because the apex has an externally managed DNS origin record
  that Cloudflare Custom Domains will not replace. The route covers every apex
  request at the edge while preserving the existing DNS record.

The successful command writes a sanitized, append-only manifest under
`.conduct/deployments/`. It records Worker release/prior versions, Hyperdrive
ID, R2 policy, lock/config digests, migration and backup identifiers, hosts, and
smoke results. It records secret names only.

## Live OAuth, MCP, and email gates

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

The gate uses the SSL-protected direct Railway audit connection to prove a
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
dashboards show healthy Railway backups, Cloudflare Email Service onboarding,
both application Custom Domains as active, and the PostHog proxy as live. In the
browser network panel, trigger an explicit product event, confirm its request to
`user.skillplane.dev` returns `200`, and confirm the event appears in PostHog.
Verify the independently managed landing zone route from its own workspace.

## Failure handling

- A missing or malformed Hyperdrive ID fails before any generated config or
  Cloudflare mutation. A well-formed ID for an absent or different origin also
  fails before R2 or Worker mutation.
- A backup, SSL, migration, or schema verification failure stops before
  deployment.
- A partial Worker deployment leaves
  `.data/production/release-in-progress.json` with sanitized completed-version
  state. Inspect it and active Cloudflare deployments before retrying.
- Never select another account's Hyperdrive configuration by position or infer
  an ID from unrelated resources.
- Never retry a deployment by bypassing `--strict`, changing the canonical
  domains, publishing R2, or placing `RAILWAY_DATABASE_URL` in Worker vars.
