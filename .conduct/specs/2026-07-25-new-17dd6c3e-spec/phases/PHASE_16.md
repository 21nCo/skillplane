# PHASE_16 — Railway and Cloudflare production deployment

## Phase goal

Deploy the verified product to Railway-backed Postgres through Hyperdrive with production R2, Email Service, Turnstile, Workers, domains, observability, and rollback.

## In scope

- Railway database migration and backup.
- User-supplied Hyperdrive ID.
- R2 bucket and bindings.
- Cloudflare Email Service binding.
- Turnstile keys.
- Landing, app, and MCP Worker deployment.
- DNS/routes/TLS.
- Production smoke, monitoring, and rollback.

## Out of scope

- Domain purchase or Cloudflare plan changes, already satisfied by the user.
- New product features.
- Placeholder binding IDs.

## Deliverables

- `scripts/render-deploy-config.mjs`
- `scripts/deploy-landing.mjs`
- `scripts/deploy-app.mjs`
- `scripts/deploy-mcp.mjs`
- `scripts/deploy-all.mjs`
- `scripts/rollback.mjs`
- `scripts/production-smoke.mjs`
- environment-specific Wrangler source templates without fake IDs
- generated ignored Wrangler deployment configs
- `docs/operations/deployment.md`
- `docs/operations/rollback.md`
- `docs/operations/backup-restore.md`
- sanitized deployment manifest under `.conduct/deployments/`
- engineering log, production observations/screenshots, phase report, and ledger append

## Requirements covered

- `DATA-001`
- `DATA-004`
- `AUTH-002`
- `AUTH-005`
- `OPS-002`
- `OPS-003`
- `OPS-004`
- `OPS-005`
- `OPS-006`
- `QA-004`

## Implementation tasks

1. Require and validate the user-supplied Hyperdrive ID; do not emit a production config without it.
2. Verify Railway SSL connection, take a pre-migration backup, and apply committed migrations directly.
3. Create or bind the private production R2 bucket and verify object lifecycle policy.
4. Bind Cloudflare Email Service for the onboarded domain and send a controlled OTP test.
5. Bind Turnstile, secrets, and observability configuration.
6. Render deployment configs into ignored generated paths and record only sanitized binding identifiers.
7. Deploy landing, app, and MCP Workers in dependency-safe order.
8. Configure routes for `skillplane.dev`, `app.skillplane.dev`, and `mcp.skillplane.dev`.
9. Verify OAuth metadata, token audience, app cookies/CORS, public cache headers, private `no-store`, R2, DataFn, and Hyperdrive paths.
10. Execute rollback rehearsal without data loss.
11. Capture production screenshots and sanitized Worker/version evidence.

## Verification steps

```bash
pnpm deploy:check
pnpm db:backup:production
pnpm db:migrate:production
pnpm deploy:all
pnpm smoke:production
pnpm test:mcp:production
pnpm verify:email:production
pnpm verify:rollback:production
```

Expected outcomes:

- All three production hosts serve correct TLS content.
- Workers connect to Railway only through Hyperdrive at runtime.
- OTP arrives through Cloudflare Email Service.
- OAuth and MCP tools work with production resource audience.
- Backup and rollback evidence is complete.

## Stop condition

Report deployment versions, sanitized binding inventory, migration/backup IDs, production smoke, OTP evidence, MCP conformance, rollback result, and screenshots before `PHASE_17`.
