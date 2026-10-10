# PHASE_16 blocked report

## Metadata

| Field | Value |
|---|---|
| Timestamp | `2026-07-26T17:05:20Z` |
| Agent | `unknown-agent` |
| Model | `GPT-5` |
| Launcher | `Codex Desktop` |
| Workspace | repository root |
| Environment | `Darwin arm64`, shell `zsh`, local Docker Postgres, Cloudflare read-only inspection |
| Git | branch `main`; no initial commit; project source remains uncommitted |

## Phase

`PHASE_16` — Railway and Cloudflare production deployment

## Status

**BLOCKED**

The complete production release, backup, migration, smoke, MCP, email, and
rollback tooling is implemented and passes local/static/dry-run gates.
Production deployment cannot begin because the Railway/Hyperdrive and
Turnstile provider inputs are absent. No live resource was mutated and no live
gate is waived.

## Requirements state

| Requirement | State | Evidence |
|---|---|---|
| `DATA-001` | IMPLEMENTED; LIVE BLOCKED | Railway direct backup/migration and Hyperdrive-only Worker runtime enforced; no production URL supplied |
| `DATA-004` | IMPLEMENTED; LIVE BLOCKED | Private R2 provisioning, immutable binding policy, inventory/recovery documentation; bucket not created |
| `AUTH-002` | IMPLEMENTED; LIVE BLOCKED | Cloudflare adapter and sending subdomain already delivered in Phase 3; deployed OTP not yet exercised |
| `AUTH-005` | IMPLEMENTED; LIVE BLOCKED | Production OAuth metadata/MCP SDK gate implemented; no deployed resource/token |
| `OPS-002` | IMPLEMENTED; LIVE BLOCKED | Three Worker configs, Custom Domains, TLS/content smoke; hosts currently return 525 |
| `OPS-003` | IMPLEMENTED; LIVE BLOCKED | Email/Turnstile binding policy and live verifier implemented; Turnstile keys absent |
| `OPS-004` | LOCAL PASS; LIVE BLOCKED | Strict config, secret separation, redaction, clean-source and security scans pass |
| `OPS-005` | IMPLEMENTED; LIVE BLOCKED | Readiness, cache, observability, and production smoke implemented; no live latency path |
| `OPS-006` | IMPLEMENTED; LIVE BLOCKED | Encrypted backup, empty-target restore, R2 reconciliation, rollback rehearsal implemented; no Railway release |
| `QA-004` | PARTIAL | Local evidence complete; production versions, screenshots, manifest, OTP, MCP, and rollback evidence absent |

No requirement is marked production-complete without its live evidence.

## Production implementation

### Configuration and deployment

- Environment-specific source templates contain no fake Hyperdrive ID.
- Generated configs are ignored, mode `0600`, atomically replaced, and
  validated before use.
- App, MCP, and landing use canonical Custom Domains with `workers_dev: false`
  and Worker observability enabled.
- The Railway URL is never placed in a Worker variable. Runtime access is
  Hyperdrive-only.
- A candidate Hyperdrive ID is read back from Cloudflare and its host, port,
  database, and user must exactly match the Railway URL.
- Deployment requires a fresh matching backup, a recent verified migration,
  and a clean committed source digest.
- On first release, each Worker receives a rollback baseline and a distinct
  release version.

### Least privilege

- App receives Hyperdrive, private R2, assets, Email Service, and its three
  required secrets.
- MCP receives Hyperdrive, private R2, OAuth issuer, and only
  `OAUTH_TOKEN_PEPPER`.
- Landing receives assets and the public app origin only.
- MCP has no Email Service, AuthFn OTP, or Turnstile authority.

### Database and recovery

- Production backup shares one exported repeatable-read snapshot between
  inventory and `pg_dump`.
- SSL is verified through `pg_stat_ssl`; the client image matches Railway's
  server major.
- The custom dump is encrypted before disk, round-trip verified, and accepted
  by `pg_restore --list`.
- Migration refuses to run without a recent matching backup and verifies the
  complete schema/migration contract afterward.
- Restore refuses the source database, non-SSL targets, and non-empty targets;
  it validates pre-upgrade inventory, applies forward migrations, and leaves
  the recovery database for inspection.
- Rollback returns all Workers to their release versions even after rehearsal
  failure, reruns smoke, and proves full-row/migration state unchanged.

### Live verification

- Smoke checks canonical TLS content, public and immutable caches, private
  `no-store`, readiness through Hyperdrive/Postgres/R2, no private wildcard
  CORS, OAuth metadata, MCP bearer challenge, and DataFn authentication.
- The MCP gate uses the official SDK, requires an OAuth access token rather
  than a service credential, lists nine tools, and calls `skills_search` with
  agent/model attribution.
- The email gate proves a Cloudflare provider message ID, consumed OTP
  challenge, secure session, and controlled recipient while persisting hashes
  only.

## Local verification

| Command/check | Result |
|---|---:|
| `pnpm deploy:check` | PASS — 19/19 plus app/MCP/landing production dry-runs |
| Config tests | PASS — 10/10 |
| MCP tests | PASS — 2/2 |
| API tests | PASS — 5/5 |
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS — 29/29 |
| `pnpm security:scan` | PASS — 0 high/critical, no finding |
| `pnpm client-secrets:verify` | PASS |
| Rollback digest SQL | PASS against local Postgres |
| Dry-run cleanup | PASS |

Wrangler is authenticated. Read-only inspection found no Skillplane Worker and
no production Skillplane R2 bucket.

## Required live gates

| Command | Current result |
|---|---|
| `pnpm db:backup:production` | BLOCKED — Railway URL absent |
| `pnpm db:migrate:production` | BLOCKED — Railway URL/backup absent |
| `pnpm deploy:all` | BLOCKED — Hyperdrive/Turnstile/provider inputs absent |
| `pnpm smoke:production` | FAIL — all hosts return Cloudflare 525 |
| `pnpm test:mcp:production` | BLOCKED — no deployment/OAuth token |
| `pnpm verify:email:production` | BLOCKED — no deployment/controlled recipient |
| `pnpm verify:rollback:production` | BLOCKED — no release record |

## Exact user dependencies

Put these real values in ignored, mode-`0600`
`.env.production.local` and report that the file is ready:

1. `RAILWAY_DATABASE_URL`
2. `CLOUDFLARE_HYPERDRIVE_ID`
3. `PUBLIC_TURNSTILE_SITE_KEY`
4. `TURNSTILE_SECRET_KEY`

The project has already generated strong independent `AUTHFN_SECRET`,
`OAUTH_TOKEN_PEPPER`, and `SKILLPLANE_BACKUP_ENCRYPTION_KEY` values in that
file without printing them.

After deployment, provide or use a controlled email inbox for one interactive
production OTP. The release process can create the test workspace, agent, and
OAuth authorization from that account.

No new Email Sending onboarding is needed: the dedicated
`auth.skillplane.dev` sender and inbox delivery were proven in Phase 3.
Cloudflare authentication, domain ownership, and Workers Paid prerequisites
are also already satisfied.

## Deliverables

Implemented scripts:

- `scripts/init-production-secrets.mjs`
- `scripts/render-deploy-config.mjs`
- `scripts/production-backup.mjs`
- `scripts/production-migrate.mjs`
- `scripts/restore-production-backup.mjs`
- `scripts/deploy-app.mjs`
- `scripts/deploy-mcp.mjs`
- `scripts/deploy-landing.mjs`
- `scripts/deploy-all.mjs`
- `scripts/production-smoke.mjs`
- `scripts/test-mcp-production.mjs`
- `scripts/verify-email-production.mjs`
- `scripts/rollback.mjs`

Added production Wrangler templates and deployment, rollback, and
backup/restore runbooks. Local evidence, engineering log, observations,
screenshot blocker index, and this report are recorded.

The sanitized deployment manifest, Worker versions, live screenshots, backup
and migration IDs, OTP/MCP evidence, and rollback record do not exist because
deployment has not occurred.

## Superfunctions

No Superfunctions source was modified in Phase 16.

## Ready for PHASE_17?

**No.** Resume Phase 16 after the four provider values and controlled OTP
inbox are available. Do not start Phase 17 until every live command exits zero
and the production evidence set is complete.
