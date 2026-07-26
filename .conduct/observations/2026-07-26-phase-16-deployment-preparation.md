# PHASE_16 deployment preparation observations

- Date: `2026-07-26`
- Result: local release path ready; production remains blocked

## Provider state

- Wrangler authentication is active with the required Cloudflare product
  permissions.
- The three Skillplane Workers do not exist.
- The private production R2 bucket does not exist.
- `skillplane.dev`, `app.skillplane.dev`, and `mcp.skillplane.dev` currently
  terminate at Cloudflare with HTTP `525`, so no Skillplane content or
  trustworthy TLS application path is live.
- The deployment templates declare all three hosts as Worker Custom Domains
  with `workers_dev` disabled. A successful release will supersede the current
  broken origin path.
- Same-day Phase 3 evidence proves Email Sending on
  `auth.skillplane.dev` and actual inbox delivery. Pinned Wrangler 4.86.0's
  beta settings command currently returns a malformed-API response, so that
  command is not accepted as a health signal.

## Fail-closed behavior

- Missing or malformed Hyperdrive IDs are rejected before config generation.
- A syntactically valid Hyperdrive ID is read back and its Railway origin is
  compared exactly before R2 creation or Worker deployment.
- Backup and migration safety records are bound to a password-free database
  fingerprint and expire after 24 hours and two hours respectively.
- A deployment requires a clean committed source revision and verifies the
  source digest again after smoke.
- First release creates a distinct rollback baseline and release version for
  every Worker.
- Rollback restores every Worker even after rehearsal failure, then proves an
  order-independent full-row digest and migration ledger are unchanged.

## Binding observations

- App is the only Worker that can send authentication email or evaluate
  Turnstile.
- MCP receives only Hyperdrive, private R2, OAuth issuer configuration, and
  the OAuth token pepper.
- Landing has no database, storage, email, or secret binding.
- Production Worker configuration contains no direct Railway URL.

## Backup and recovery observations

- The backup transaction exports one repeatable-read snapshot shared by
  inventory and `pg_dump`.
- The Postgres client image is selected from the live server major version.
- Plaintext backup bytes exist only in memory, are encrypted with
  AES-256-GCM and scrypt, round-trip verified, and accepted by
  `pg_restore --list`.
- Restore refuses the source or a non-empty/non-SSL Railway database and
  retains the recovery database for inspection.

## Secrets

- Three independent generated secrets are stored only in ignored
  `.env.production.local`, mode `0600`.
- Their values were not printed or written to `.conduct`.
- Railway, Hyperdrive, and Turnstile provider values remain absent.

## Source revision continuation

- The initial 702-file Skillplane commit was created only after staged
  whitespace, ignored-path, and generated-secret-value checks passed.
- The production clean-source guard returned the committed revision and
  `clean: true`.
- The source revision prerequisite is closed; provider inputs remain the only
  pre-deployment dependency.
