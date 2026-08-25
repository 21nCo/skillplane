# Development deployment

Skillplane's persistent development environment isolates the stateful,
addressable, credential, and email-identity boundaries below from production:

| Boundary     | Development                          | Production                       |
| ------------ | ------------------------------------ | -------------------------------- |
| App Worker   | `skillplane-app-dev`                 | `skillplane-app`                 |
| MCP Worker   | `skillplane-mcp-dev`                 | `skillplane-mcp`                 |
| App host     | `app-dev.skillplane.dev`             | `app.skillplane.dev`             |
| MCP resource | `https://mcp-dev.skillplane.dev/mcp` | `https://mcp.skillplane.dev/mcp` |
| R2 bucket    | `skillplane-skill-bundles-dev`       | `skillplane-skill-bundles`       |
| Database     | A distinct PostgreSQL database       | Production PostgreSQL database   |
| Hyperdrive   | `CLOUDFLARE_DEV_HYPERDRIVE_ID`       | `CLOUDFLARE_HYPERDRIVE_ID`       |
| Secrets      | `SKILLPLANE_DEV_*` inputs            | Production secret inputs         |
| Email sender | `no-reply@auth-dev.skillplane.dev`   | `no-reply@auth.skillplane.dev`   |

The development runtime uses `RUNTIME_ENV=preview`: it retains production-like
OTP, Email Service, Hyperdrive, R2, and HTTPS requirements while allowing the
development OAuth issuer and resource. The production runtime continues to reject
these development identities.

## One-time provider setup

1. Select a separate password-authenticated PostgreSQL database reachable over
   TLS. The provider and database name are not used as environment boundaries.
2. Create a cache-disabled Hyperdrive configuration for that database.
3. Create a Turnstile widget allowing only `app-dev.skillplane.dev`.
4. Onboard `auth-dev.skillplane.dev` with Cloudflare Email Service and authorize
   only `no-reply@auth-dev.skillplane.dev` for the development app Worker.
5. Create the `app-dev.skillplane.dev` and `mcp-dev.skillplane.dev` custom domains.
   Remove the old `app.dev.skillplane.dev` and `mcp.dev.skillplane.dev` routes in
   the same cutover because their OAuth discovery identities are no longer valid.
6. Create a dedicated `SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN`. Do not reuse the
   production or ambient Wrangler token. Limit it to the account and zones needed
   by the development Workers, R2 bucket, Hyperdrive, and custom domains.
7. Create `SKILLPLANE_PRODUCTION_R2_READ_TOKEN` with read-only object access to
   `skillplane-skill-bundles`. Keep it distinct from the development token.

Development and authenticated local OTP emails use the development sender, never
the production sender. Every OTP identifies its environment and expected sign-in
site. Default local startup continues to keep OTP authentication disabled.

Put the following values in the ignored `.env.development.local` file and set
its mode to `0600`:

```dotenv
SKILLPLANE_DEV_DATABASE_URL=postgresql://...
CLOUDFLARE_DEV_HYPERDRIVE_ID=...
SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN=...
SKILLPLANE_PRODUCTION_R2_READ_TOKEN=...
SKILLPLANE_DEV_AUTHFN_SECRET=...
SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER=...
SKILLPLANE_DEV_TURNSTILE_SECRET_KEY=...
PUBLIC_DEV_TURNSTILE_SITE_KEY=...
```

The deployment rejects a database that matches
`SKILLPLANE_PRODUCTION_DATABASE_URL` (or the temporary legacy
`RAILWAY_DATABASE_URL`), a cache-enabled or mismatched Hyperdrive, a development
Hyperdrive ID copied from production, a dirty source tree, a development API
token reused from an ambient or production token, or generated configuration
containing production identities. When production secret or Turnstile variables
are also present in the invoking environment, the deployment additionally
rejects copied development values.

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
