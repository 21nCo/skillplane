# Development deployment

Skillplane's persistent development environment is isolated from production at
every stateful and addressable boundary:

| Boundary     | Development                                   | Production                       |
| ------------ | --------------------------------------------- | -------------------------------- |
| App Worker   | `skillplane-app-dev`                          | `skillplane-app`                 |
| MCP Worker   | `skillplane-mcp-dev`                          | `skillplane-mcp`                 |
| App host     | `app.dev.skillplane.dev`                      | `app.skillplane.dev`             |
| MCP resource | `https://mcp.dev.skillplane.dev/mcp`          | `https://mcp.skillplane.dev/mcp` |
| R2 bucket    | `skillplane-skill-bundles-dev`                | `skillplane-skill-bundles`       |
| Database     | A Railway database with a distinct `dev` name | Production Railway database      |
| Hyperdrive   | `CLOUDFLARE_DEV_HYPERDRIVE_ID`                | `CLOUDFLARE_HYPERDRIVE_ID`       |
| Secrets      | `SKILLPLANE_DEV_*` inputs                     | Production secret inputs         |

The development runtime uses `RUNTIME_ENV=preview`: it retains production-like
OTP, Email Service, Hyperdrive, R2, and HTTPS requirements while allowing the
development OAuth issuer and resource. The production runtime continues to reject
these development identities.

## One-time provider setup

1. Create a separate Railway database whose database name contains a distinct
   `dev` segment, such as `skillplane_dev`.
2. Create a cache-disabled Hyperdrive configuration for that database.
3. Create a Turnstile widget allowing only `app.dev.skillplane.dev`.
4. Confirm Cloudflare Email Service can send from
   `no-reply@auth.skillplane.dev`.
5. Ensure the two development custom domains belong to the same Cloudflare
   account used by Wrangler.

Put the following values in the ignored `.env.development.local` file and set
its mode to `0600`:

```dotenv
SKILLPLANE_DEV_DATABASE_URL=postgresql://...
CLOUDFLARE_DEV_HYPERDRIVE_ID=...
SKILLPLANE_DEV_AUTHFN_SECRET=...
SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER=...
SKILLPLANE_DEV_TURNSTILE_SECRET_KEY=...
PUBLIC_DEV_TURNSTILE_SITE_KEY=...
```

The deployment rejects a database without a `dev` name segment, a database that
matches `RAILWAY_DATABASE_URL`, a cache-enabled or mismatched Hyperdrive, a dirty
source tree, or generated configuration containing production identities.

## Deploy and verify

```bash
pnpm deploy:check
pnpm db:migrate:dev
pnpm deploy:dev:render
pnpm deploy:dev
pnpm smoke:dev
pnpm test:dev:oauth
```

`deploy:dev` creates the private development R2 bucket if necessary, builds the
complete workspace, and deploys the app followed by MCP. It does not read
`.env.production.local`, mutate the production Workers, or run production backup,
migration, deployment, smoke, or rollback commands.

The final OAuth verifier requires an interactive browser sign-in and consent. It
proves discovery, dynamic registration, PKCE, token exchange, audience validation,
authenticated Streamable HTTP, tool discovery, and `workspaces_list` against the
deployed development environment.
