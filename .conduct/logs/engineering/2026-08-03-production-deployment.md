# Phase 16 production deployment

- Started: `2026-08-03T04:30:16Z`
- Completed: `2026-08-03T05:31:28Z`
- Status: PASS
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

## Release hardening findings

- The first apex release exposed landing asset URLs as root-relative paths.
  The production smoke gate now verifies asset retrieval against the landing
  origin and the release serves the complete document through the zone route.
- Unauthenticated DataFn calls initially reached an early failure path that
  returned HTTP `500`. The application now establishes the production
  authentication boundary before dispatch and returns HTTP `401` with
  `Cache-Control: no-store`.
- Native OAuth form posts omit the browser `Origin` header. SvelteKit's own
  cross-site form guard remains enabled, while AuthFn accepts these same-origin
  native posts and continues to enforce state, client, redirect URI, PKCE, code
  lifetime, and one-time use.
- Smoke traffic legitimately advances `api_rate_limits`. Rollback therefore
  proves exact schema, migration ledger, and durable table state while treating
  only that operational counter table as mutable. Unit coverage rejects any
  durable row, schema, or migration change.

## Final release

- Release tag: `phase16-2026-08-03T05-09-46-594Z`.
- App version: `10796137-167d-43b6-a664-17efa8036c3d` on
  `app.skillplane.dev`.
- MCP version: `009fb9c5-bda4-476c-b819-a227dbbe987d` on
  `mcp.skillplane.dev`.
- Landing version: `5858f9fe-273a-4468-a17e-79e8ad418ca7` on
  `skillplane.dev/*`.
- Sanitized release manifest:
  `.conduct/deployments/2026-08-03T05-09-46-593Z-phase16-2026-08-03T05-09-46-594Z.json`.
- Sanitized rollback record:
  `.conduct/deployments/2026-08-03T05-18-10-817Z-phase16-2026-08-03T05-09-46-594Z-rollback.json`.

## Live verification

- Production smoke passed before and after rollback: landing and app return
  HTTP `200`; unauthenticated MCP returns HTTP `401` with a bearer challenge;
  configuration, Railway through Hyperdrive, and R2 readiness are healthy.
- A real Cloudflare Email Service OTP was delivered to the controlled account,
  consumed in the production browser, and correlated with an active AuthFn
  session over an SSL database connection.
- A dynamically registered OAuth client completed authorization-code plus PKCE
  `S256`. The official MCP SDK negotiated protocol `2025-11-25`, verified the
  MCP resource audience, enumerated exactly nine production tools, and
  exercised caller attribution containing agent, model, client, run, user, and
  represented-user fields.
- The rollback rehearsal moved all three Workers to their exact prior versions,
  passed smoke, restored all three release versions, passed smoke again, and
  proved the schema, migration ledger, and durable database state unchanged.

No Superfunctions source was changed during the completed production release.
