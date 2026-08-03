# Phase 16 production deployment

- Started: `2026-08-03T04:30:16Z`
- Status: in progress
- Scope: Railway migration, Hyperdrive and R2 validation, three-Worker release,
  live smoke verification, OAuth/MCP/email verification, and rollback rehearsal.

## Database safety

- Created and round-trip verified a fresh encrypted Railway backup over TLS 1.3.
- Applied migrations `0001` through `0015` to the empty production database.
- Verified 31 required tables, integrity constraints, triggers, and indexed query
  plans before the first Worker mutation.

## Cloudflare resources

- Confirmed Hyperdrive targets the exact controlled Railway host, port, database,
  and user.
- Created the private `skillplane-skill-bundles` R2 bucket with incomplete
  multipart cleanup only; public development URL and custom domains remain off.
- Deployed baseline and release versions for the app and MCP Workers.

## Apex routing incident

- The first landing deployment uploaded successfully but Cloudflare rejected its
  Custom Domain trigger with provider error `100117` because `skillplane.dev`
  already has an externally managed apex A/CNAME origin record.
- The authenticated Wrangler token cannot mutate DNS by design. Dashboard login
  reached the account's security-key 2FA boundary; no DNS record was deleted.
- Decision: preserve the unknown externally managed apex record and bind the
  landing Worker through the proxied zone route `skillplane.dev/*`. This routes
  every apex path at the Cloudflare edge and retains Cloudflare-managed TLS.
- Updated production template validation, dry-run coverage, manifest routing
  metadata, and the operations runbook for the mixed routing topology.

No Superfunctions repository was modified.
