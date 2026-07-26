# PHASE_16 local deployment verification

- Recorded: `2026-07-26T17:05:20Z`
- Status: `PASS locally; live deployment BLOCKED`
- Environment: Darwin arm64, Node 20.20.0, pnpm 11.9.0, Wrangler 4.86.0

## Local and read-only gates

| Gate | Result | Evidence |
|---|---:|---|
| `pnpm deploy:check` | PASS | 19/19 workspace tasks plus app, MCP, and landing production-template strict dry-runs |
| Deployment self-test | PASS | Missing ID fails closed; Railway SSL enforced; exact Hyperdrive origin match accepted; unrelated origin rejected; active version and redaction parsing pass |
| Production config cleanup | PASS | Ephemeral configs and dry-run output directories are removed in `finally` |
| Config unit tests | PASS | 10/10, including OAuth-only MCP runtime without email or Turnstile |
| MCP unit tests | PASS | 2/2 |
| API unit tests | PASS | 5/5 |
| `pnpm format:check` | PASS | All tracked and untracked project files formatted |
| `pnpm lint` | PASS | No finding |
| `pnpm typecheck` | PASS | 29/29 tasks; Svelte checks have zero errors/warnings |
| `pnpm security:scan` | PASS | 288 source files, 334 bundle files, 17 manifests, 0 high/critical, no production finding |
| `pnpm client-secrets:verify` | PASS | App and landing client bundles contain no secret |
| Rollback row digest SQL | PASS | Executed read-only against local Postgres; 15 migration rows produced both full-row digest halves |
| Wrangler authentication | PASS | Logged in with Workers, routes, R2, Hyperdrive, and Email permissions; account identifiers omitted |
| Production env handoff | PASS | `.env.production.local` ignored and mode `0600`; three independent secrets generated without printing values |

The production dry-run binding inventory proves:

- app: Hyperdrive, private R2, assets, Email Service, production variables,
  Turnstile site key;
- MCP: Hyperdrive, private R2, production/OAuth variables only;
- landing: assets and app origin only.

MCP does not receive Email Service, AuthFn OTP, or Turnstile bindings. Its
secret file contains only `OAUTH_TOKEN_PEPPER`.

## Live gate state

| Required command | State | Reason |
|---|---:|---|
| `pnpm db:backup:production` | BLOCKED | `RAILWAY_DATABASE_URL` absent |
| `pnpm db:migrate:production` | BLOCKED | Railway URL and verified matching backup absent |
| `pnpm deploy:all` | BLOCKED | User-supplied Hyperdrive ID and provider inputs absent; source has no initial commit |
| `pnpm smoke:production` | FAIL CLOSED | All three hosts currently return Cloudflare `525` |
| `pnpm test:mcp:production` | BLOCKED | No deployed MCP resource or production OAuth token/workspace |
| `pnpm verify:email:production` | BLOCKED | No deployed app or controlled OTP recipient/session |
| `pnpm verify:rollback:production` | BLOCKED | No successful production release record |

Read-only Cloudflare inspection found no `skillplane-app`,
`skillplane-mcp`, or `skillplane-landing` Worker and no
`skillplane-skill-bundles` bucket. No live Cloudflare resource was mutated.

## Inputs needed to resume

Add these actual values to the ignored mode-`0600`
`.env.production.local` file:

- `RAILWAY_DATABASE_URL`
- `CLOUDFLARE_HYPERDRIVE_ID`
- `PUBLIC_TURNSTILE_SITE_KEY`
- `TURNSTILE_SECRET_KEY`

The Hyperdrive configuration must target the exact Railway host, port,
database, and user in the URL; deployment verifies this from Cloudflare before
the first mutation.

After deployment, a controlled production email recipient must complete one
OTP sign-in. The same controlled account can then create the live workspace,
agent record, and OAuth authorization used by the MCP gate.

`auth.skillplane.dev` Email Sending and actual inbox delivery were already
proven in the successful Phase 3 re-verification. Phase 16 still requires a
real OTP through the deployed app.

## Clean source revision

Recorded at `2026-07-26T17:11:35Z`:

- staged boundary: 702 files, 100,677 inserted lines;
- whitespace check: pass;
- generated production values: absent from the staged index;
- ignored secret/runtime paths: absent from the staged index;
- initial commit: `13c2d3c3c6234505af6289f564e93418c643881c`;
- commit subject: `feat: implement Skillplane platform`;
- `requireCleanSourceRevision()`: `{ clean: true }`.

The source-commit blocker is closed. Deployment remains blocked only on
provider values and live interaction.
