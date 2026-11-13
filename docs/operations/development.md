# Development deployment

Skillplane's persistent development environment isolates the stateful,
addressable, credential, and email-identity boundaries below from production:

| Boundary     | Development                                     | Production                                   |
| ------------ | ----------------------------------------------- | -------------------------------------------- |
| App Worker   | `skillplane-app-dev`                            | `skillplane-app`                             |
| MCP Worker   | `skillplane-mcp-dev`                            | `skillplane-mcp`                             |
| App host     | `skillplane-app.21n.dev`                        | `app.skillplane.dev`                         |
| MCP resource | `https://skillplane-mcp.21n.dev/mcp`            | `https://mcp.skillplane.dev/mcp`             |
| R2 bucket    | `skillplane-skill-bundles-dev`                  | `skillplane-skill-bundles`                   |
| Database     | A distinct PostgreSQL database                  | Production PostgreSQL database               |
| Hyperdrive   | `CLOUDFLARE_DEV_HYPERDRIVE_ID`                  | `CLOUDFLARE_HYPERDRIVE_ID`                   |
| Secrets      | `SKILLPLANE_DEV_*` inputs                       | Production secret inputs                     |
| Email sender | `no-reply@skillplane-auth.21n.dev`              | `no-reply@auth.skillplane.dev`               |
| Analytics    | Dedicated project via `user-dev.skillplane.dev` | Production project via `user.skillplane.dev` |
| CF account   | `21n-dev`                                       | `21n`                                        |

The development runtime uses `RUNTIME_ENV=preview`: it retains production-like
OTP, Email Service, Hyperdrive, R2, and HTTPS requirements while allowing the
development OAuth issuer and resource. The production runtime continues to reject
these development identities.

## One-time provider setup

1. Select a separate password-authenticated PostgreSQL database reachable over
   TLS. The provider and database name are not used as environment boundaries.
2. Create a cache-disabled Hyperdrive configuration for that database.
3. Create a Turnstile widget allowing only `skillplane-app.21n.dev`.
4. Onboard `skillplane-auth.21n.dev` with Cloudflare Email Service in the `21n-dev`
   account and authorize only `no-reply@skillplane-auth.21n.dev` for the
   development app Worker. (Authenticated local startup keeps the separate
   `no-reply@auth-dev.skillplane.dev` sender.)
5. Development Workers deploy to the `21n-dev` Cloudflare account. Wrangler
   creates the `skillplane-app.21n.dev`, `skillplane-mcp.21n.dev`, and
   `skillplane-datafn-<region>.21n.dev` custom domains on the `21n.dev` zone.
   Set `CLOUDFLARE_ACCOUNT_ID` to the `21n-dev` account ID when deploying.
6. Create a dedicated `SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN`. Do not reuse the
   production or ambient Wrangler token. Limit it to the `21n-dev` account and
   the `21n.dev` zone needed by the development Workers, R2 buckets, Hyperdrive,
   and custom domains. The token must be single-account: see
   [Development token account check](#development-token-account-check).
7. Create `SKILLPLANE_PRODUCTION_R2_READ_TOKEN` with read-only object access to
   `skillplane-skill-bundles`. Keep it distinct from the development token.
   `r2:sync:dev` reads production bundles from the account in
   `SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID` (the production `21n` account),
   while `CLOUDFLARE_ACCOUNT_ID` keeps selecting `21n-dev` for development writes.
   Every development deploy, migration, sync, and smoke command requires both
   values and refuses to run when the development token can access the
   production account, the release account, or any account other than
   `CLOUDFLARE_ACCOUNT_ID`: see
   [Development token account check](#development-token-account-check).
8. Create a dedicated PostHog development project and configure its managed
   reverse proxy at `user-dev.skillplane.dev`. Keep its project token distinct
   from production.

Development and authenticated local OTP emails use the development sender, never
the production sender. Every OTP identifies its environment and expected sign-in
site. Default local startup continues to keep OTP authentication disabled.

Put the following values in the ignored `.env.development.local` file and set
its mode to `0600`:

```dotenv
CLOUDFLARE_ACCOUNT_ID=<21n-dev account ID>
SKILLPLANE_DEV_DATABASE_URL=postgresql://...
CLOUDFLARE_DEV_HYPERDRIVE_ID=...
SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN=...
SKILLPLANE_PRODUCTION_R2_READ_TOKEN=...
SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID=<21n production account ID>
SKILLPLANE_DEV_AUTHFN_SECRET=...
SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER=...
SKILLPLANE_DEV_TURNSTILE_SECRET_KEY=...
PUBLIC_DEV_TURNSTILE_SITE_KEY=...
PUBLIC_POSTHOG_KEY=phc_development_project_token
```

The deployment rejects a database that matches
`SKILLPLANE_PRODUCTION_DATABASE_URL`, a cache-enabled or mismatched Hyperdrive,
a development Hyperdrive ID copied from production, a dirty source tree, a
development API token reused from an ambient or production token, or generated
configuration containing production identities. When production secret or
Turnstile variables are also present in the invoking environment, the
deployment additionally rejects copied development values.

Markdown authoring uses the shared mdfn profile documented in
[`mdfn.md`](./mdfn.md).

The development renderer exposes `PUBLIC_POSTHOG_KEY` and
`https://user-dev.skillplane.dev` to the browser app. It supplies the same
project token to the MCP Worker as the `POSTHOG_PROJECT_TOKEN` secret and uses
the canonical US ingestion host for MCP traffic. The token must differ from a
production `POSTHOG_PROJECT_TOKEN` present in the invoking environment.

## Development token account check

Every development deploy, migration, sync, and smoke command (`deploy:dev`,
`deploy:dev:topology`, `db:migrate:dev`, `db:migrate:dev:topology`,
`db:prepare:dev:topology`, `r2:sync:dev`, `smoke:dev`, and `test:dev:oauth`)
first lists the Cloudflare accounts that `SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN`
can access (`GET /accounts`). The command continues only when that list is
exactly the account in `CLOUDFLARE_ACCOUNT_ID`, before it renders a
configuration, runs Wrangler, or opens a database. It stops with
`DEV_CLOUDFLARE_TOKEN_SCOPE:` when the token can access:

- `SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID` or, when set,
  `SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID` (the production release account);
- any other account, even alongside the development account; or
- no account.

It also stops when the listing fails, for example on a network error or an HTTP
error status. There is no skip flag. The error names the account IDs and the
variable that supplied the token, never the token. Every one of these commands
therefore needs the development token, the development account ID, and the
production account ID, including the migration and smoke commands.

## Deploy and verify

```bash
pnpm deploy:check
pnpm db:migrate:dev
pnpm r2:sync:dev
pnpm deploy:dev:render
pnpm deploy:dev
pnpm smoke:dev
pnpm test:dev:oauth
```

Run `r2:sync:dev` after restoring or copying database data into development. It
copies only immutable bundles referenced by the development database from the
production bucket into the private development bucket. Before copying, it
verifies each production object's recorded SHA-256 digest and byte size. It then
verifies the destination key, size, and object ETag. The command is idempotent
and never deletes objects from either bucket. It creates and verifies the private
development bucket when necessary. The production token must grant read-only
access to `skillplane-skill-bundles`; the development token remains responsible
for the target bucket, and the command rejects a shared token.

`deploy:dev` creates the private development R2 bucket if necessary, builds the
complete workspace, and deploys the app followed by MCP. It does not read
`.env.production.local`, mutate the production Workers, or run production backup,
migration, deployment, smoke, or rollback commands.

The final OAuth verifier requires an interactive browser sign-in and consent. It
proves discovery, dynamic registration, PKCE, token exchange, audience validation,
authenticated Streamable HTTP, tool discovery, and `workspaces_list` against the
deployed development environment.

## Three-cell gateway development topology

The compatibility `deploy:dev` command above remains a one-database deployment. Use
the topology commands below to exercise the global gateway and private regional-cell
model on the same development authorities. The checked-in development manifest uses
`in-south`, `us-east`, and `eu-west`; every cell has distinct PostgreSQL and R2
bindings, and its app, MCP, and projection Workers have no public route.

Add these non-secret resource IDs and direct database URLs to the ignored
`.env.development.local` file:

```dotenv
SKILLPLANE_DEV_CONTROL_DATABASE_URL=postgresql://...
SKILLPLANE_DEV_DATABASE_URL=postgresql://... # in-south compatibility name
SKILLPLANE_DEV_USEAST_DATABASE_URL=postgresql://...
SKILLPLANE_DEV_EUWEST_DATABASE_URL=postgresql://...
SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES=host[:port]/database,... # production control and cells, no credentials
CLOUDFLARE_DEV_CONTROL_HYPERDRIVE_ID=...
CLOUDFLARE_DEV_CELL_IN_SOUTH_HYPERDRIVE_ID=...
CLOUDFLARE_DEV_CELL_US_EAST_HYPERDRIVE_ID=...
CLOUDFLARE_DEV_CELL_EU_WEST_HYPERDRIVE_ID=...
```

Every Hyperdrive must match its direct URL and have SQL response caching disabled.
Initialize the independent routing and encrypted-backup keys without printing them:

```bash
pnpm development:topology:secrets:init
```

For an empty control database and an existing combined India development database,
the preparation command first creates and verifies an encrypted backup, initializes
the control schema, and then removes every global/control table from the India
database while preserving its regional skill, version, context, audit, analytics,
and bundle-reference rows. US and EU are initialized as empty regional databases.
Both destructive confirmations must exactly match the database names:

```bash
pnpm db:prepare:dev:topology -- \
  --confirm-control-database <control-database-name> \
  --confirm-regionalize-database <india-database-name>
```

Render, migrate, deploy private cells before gateways, and run the normal public
smoke and OAuth gates:

```bash
pnpm deploy:check
pnpm deploy:dev:topology:render
pnpm db:migrate:dev:topology
pnpm deploy:dev:topology
pnpm smoke:dev
pnpm test:dev:oauth
```

`db:migrate:dev:topology` brings an already converted topology to the code's
migration head in place: control-role migrations to
`SKILLPLANE_DEV_CONTROL_DATABASE_URL`, then regional migrations to each cell URL,
then the same schema-head and table-ownership checks the deployment runs. It
never runs the `db:prepare:dev:topology` conversion and never drops, prunes, or
rewrites tables. It checks the databases in order and migrates none of them until
every check passes. The first database that is not converted stops it with
`TOPOLOGY_NOT_PREPARED:<database>:<detail>`, so a rerun can name the next one:
`<detail>` is `empty` when the database has no applied migration (the early
migrations apply to every role, so only the conversion can give an empty database
its role's shape), or the first table of the other role it still holds. Convert
the topology with `db:prepare:dev:topology` first. That command migrates the
control database and every cell database, not only the one named in the error.
It backs up only the India database, and only when India still holds the combined
schema and needs regionalization; the control, US, and EU databases get no backup.
`db:migrate:dev:topology` itself takes no backup, because development data is
disposable, but before opening a connection it refuses any URL
that identifies the same database (host, port, and database name) as a production
variable (`SKILLPLANE_CONTROL_DATABASE_URL`, `SKILLPLANE_CELL_<REGION>_DATABASE_URL`,
`SKILLPLANE_PRODUCTION_DATABASE_URL`,
`SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL`, or `RAILWAY_DATABASE_URL`)
or an entry of `SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES`. That variable lists
production databases without credentials as `host[:port]/database` entries
separated by commas or whitespace (the port defaults to `5432`); list every
hostname that reaches a production database. The command refuses with
`PRODUCTION_ISOLATION_UNCONFIGURED` before reading any URL whenever the variable is
empty, locally and in CI, because the production URL variables are usually absent
from `.env.development.local` and would otherwise be compared against nothing.
The comparison uses the host, port, and database the PostgreSQL driver will
connect to, so `db:migrate:dev:topology`, `deploy:dev:topology`, and
`db:prepare:dev:topology` refuse a development URL with
`DEVELOPMENT_DATABASE_DESTINATION_AMBIGUOUS` when its destination differs from
its URL authority: a `host`, `hostaddr`, or `port` query parameter, a
percent-encoded, trailing-dot, or numeric (non dotted-quad) host, or a URL
without a port while `PGPORT` names another port. They also refuse a control
character (`U+0000` to `U+001F` or `U+007F`, usually written `%00`, `%0A`, or `%7F`)
in the user, password, database, or any query parameter name or value. PostgreSQL
receives connection settings as NUL-terminated strings, so such a value can send a
second database name. The same rule applies to
`SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES` entries and production URL variables.
Production targets follow the same host rule, so a production target can never
silently fail to match: write each `SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES`
entry and each production URL variable with a lowercase DNS name or a
dotted-quad IPv4 address (a trailing dot and letter case are normalized). The
commands refuse a numeric (`2130706433`), shortened (`127.1`), hex (`0x7f.1`),
or octal (`0177.0.0.1`) host in an identity entry, naming the variable, and in a
production URL variable with `PRODUCTION_DATABASE_DESTINATION_AMBIGUOUS`.
Each database migrates in one transaction under the
shared migration lock, so a second or concurrent run applies nothing, and a run
interrupted between databases resumes when rerun.

Before uploading any Worker, `deploy:dev:topology` compares each database's
migration ledger with the code and fails with
`SCHEMA_BEHIND:<database>:<applied>-><head>` (for example
`SCHEMA_BEHIND:us-east:0050_regional_verification_immutability->0054_regional_artifact_kind`)
when a migration is pending. Run `pnpm db:migrate:dev:topology` and deploy again.

To roll out only selected Worker kinds during a canary, pass `--only` to the
deployment script with a comma-separated list of `app`, `datafn`, `mcp`, and
`projection`. The script still deploys regional cells before the gateway. The
`app` kind includes both regional app cells and the gateway app Worker. For
example, to update all app Workers and public regional DataFn Workers:

```bash
node --env-file=.env.development.local scripts/deploy-development-topology.mjs --only app,datafn
```

The old India AuthFn users, sessions, workspaces, memberships, and placement records
remain only in the encrypted pre-conversion backup. Existing regional India rows are
intentionally not attached to newly created control-plane users or workspaces; map or
remove that development data explicitly rather than silently granting access.

## Continuous deployment

`.github/workflows/deploy-cloudflare-dev.yml` builds pull requests and deploys
the three-cell development topology to the `21n-dev` account on every push to
the `dev` branch (or a manual `workflow_dispatch` of the `dev` branch; dispatches
from any other ref skip the deploy job). It runs `pnpm deploy:check`,
`pnpm db:migrate:dev:topology`, and then `pnpm deploy:dev:topology`, so a push
after a new migration deploys against migrated databases. The migration step
runs inside the same dev-only job, after its ref and account guard. The
one-time database preparation, `r2:sync:dev`, and the interactive OAuth verifier
remain manual.

The deploy job uses the GitHub `dev` environment. The org secret
`CLOUDFLARE_DEV_API_TOKEN` and org variable `CLOUDFLARE_DEV_ACCOUNT_ID` select the
account. The org variable `CLOUDFLARE_PROD_ACCOUNT_ID` is required too: the job
fails closed when it is missing, and refuses to deploy when the development
account equals it or the production release account (`vars.CLOUDFLARE_ACCOUNT_ID`).
The job passes both to the scripts, as `SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID`
and `SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID`, and gives the development token to
the migration and deploy steps, so each step runs the
[token account check](#development-token-account-check) first.
The variable `SKILLPLANE_PRODUCTION_DATABASE_IDENTITIES` (org or `dev`
environment) must list the production control and cell database identities as
`host[:port]/database` with canonical hosts, never URLs or credentials; the
migration step refuses to run without it. The `dev` environment must provide:

- Secrets: `SKILLPLANE_DEV_CONTROL_DATABASE_URL`, `SKILLPLANE_DEV_DATABASE_URL`,
  `SKILLPLANE_DEV_USEAST_DATABASE_URL`, `SKILLPLANE_DEV_EUWEST_DATABASE_URL`,
  `SKILLPLANE_DEV_AUTHFN_SECRET`, `SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER`,
  `SKILLPLANE_DEV_TURNSTILE_SECRET_KEY`, `SKILLPLANE_DEV_WORKSPACE_ROUTING_SECRET`,
  `PUBLIC_POSTHOG_KEY`, and, only when direct DataFn is enabled,
  `DATAFN_ROUTE_PRIVATE_KEY_PEM` and `AUTHFN_PLACEMENT_SUBJECT_SECRET`.
- Variables: `CLOUDFLARE_DEV_CONTROL_HYPERDRIVE_ID`,
  `CLOUDFLARE_DEV_CELL_IN_SOUTH_HYPERDRIVE_ID`,
  `CLOUDFLARE_DEV_CELL_US_EAST_HYPERDRIVE_ID`,
  `CLOUDFLARE_DEV_CELL_EU_WEST_HYPERDRIVE_ID`, `PUBLIC_DEV_TURNSTILE_SITE_KEY`, and
  optionally `DATAFN_DIRECT_ENABLED`, `DATAFN_DIRECT_WORKSPACES`,
  `DATAFN_ROUTE_ACTIVE_KEY_ID`, and `DATAFN_ROUTE_PUBLIC_KEYS`.

## Retire the old development deployment in `21n`

Deploys to `21n-dev` never touch the production `21n` account, so the previous
development Workers there stay deployed and keep their database secrets until they
are removed by hand. After the NPX-76 zone cutover, once
`https://skillplane-app.21n.dev` and `https://skillplane-mcp.21n.dev/mcp` pass the
smoke checks above:

1. In the `21n` account, list Workers and select only development Workers: names
   starting with `skillplane-app-dev`, `skillplane-mcp-dev`,
   `skillplane-datafn-dev-`, `skillplane-projection-dev-`, or
   `skillplane-cell-dev`. Never select `skillplane-app`, `skillplane-mcp`, or other
   production Workers.
2. Remove their custom domains (`app-dev.skillplane.dev`, `mcp-dev.skillplane.dev`,
   and `datafn-<region>-dev.skillplane.dev`) and any routes, then delete those
   Workers so they can no longer reach the development databases.
3. Delete the development-only R2 buckets (`*-dev`), Hyperdrive configurations,
   KV namespaces, D1 databases, and queues left in `21n` only after confirming
   their data exists in `21n-dev`. Leave `skillplane-skill-bundles` and every other
   production resource untouched.
4. Revoke any Cloudflare API token that was scoped to development resources in
   `21n`.
