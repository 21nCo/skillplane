# PHASE_15 hardening observations

- Date: `2026-07-26`
- Result: PASS

## Security

- Cross-tenant tests consistently authorize before retrieval or ranking; no
  protected title, digest, context, candidate, or audit field appeared in
  denied responses.
- OAuth attack responses remained standards-shaped and redacted. Wrong PKCE
  did not consume a valid code; successful replay failed; reused refresh
  tokens revoked the family.
- Bundle validation rejected path, link, encoding, duplicate, inventory, and
  expansion attacks before durable object commit.
- Markdown preserved useful instructions while removing executable HTML,
  event handlers, and unsafe URL protocols.
- R2 and audit failure responses remained typed and retryable without
  substituting cached/private content or provider diagnostics.

## Accessibility and UI

- The 390, 768, and 1440 px matrices showed no meaningful horizontal
  overflow in either theme.
- Keyboard entry, Escape dismissal, initial dialog focus, focus restoration,
  tabs, menus, command routing, mobile navigation, and skip links remained
  operable.
- Loading states announce status, fatal routes announce alerts, and
  decorative policy icons no longer add noise to the accessibility tree.
- The first exact skill-page visual run exposed two test-only sources of
  nondeterminism: a random authenticated-user suffix and modal scroll-lock
  capture. Both were made deterministic while retaining zero-pixel
  comparison.
- Reviewed list, create, mobile overview, and destructive-dialog goldens
  retained the intended compact Linear-style hierarchy and contrast.

## Performance

- The slowest measured endpoint was authenticated search at 91.12 ms p95.
- A roughly 1 MiB skill file returned at 17.20 ms p95, far below the 1,000 ms
  gate.
- Audit explorer plan execution was 162.058 ms on 1,000,031 rows and used the
  workspace/time index.
- PostgreSQL selected the primary-key scan for the selective stable-order
  search fixture; the GIN search index is nevertheless present and asserted.

## Recovery

- The manifest checksum stopped a deliberately corrupted dump before restore.
- Restored schema, migration, table, and R2 reference inventories matched the
  source.
- Cleanup deleted one old orphan only. Listing uncertainty and database
  reference uncertainty both preserved all objects.
- Recovery command output is structured JSON suitable for operator evidence
  and automation.

## Remaining observations

- Three lower-severity transitive advisories remain outside deployed runtime
  paths and are recorded in verification evidence.
- Local performance and recovery results do not predict Railway/Hyperdrive/R2
  network behavior; PHASE_16 must validate the provisioned environment.
- Automated Axe and semantic checks should be supplemented with a manual
  assistive-technology smoke before public launch.
