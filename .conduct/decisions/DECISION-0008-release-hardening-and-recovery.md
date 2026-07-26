# DECISION-0008 — Release hardening and recovery contracts

- Date: `2026-07-26`
- Status: accepted
- Scope: PHASE_15 security, accessibility, performance, and recovery

## Decision

Release verification uses disposable real Postgres databases and production
domain/runtime composition wherever state is material. The root security
runner resets the test database and serializes MCP security files because
those files deliberately share a real database. SvelteKit application and
landing accessibility/E2E suites run in separate processes, and each visual
specification runs in a fresh process, so Vite's process-level route cache and
browser rasterization state cannot cross project boundaries.

Visual comparisons retain a zero-pixel tolerance. Dynamic authenticated IDs
are normalized in the test DOM, routes begin at a known scroll position, and
modal evidence is captured at the fixed viewport because full-page capture is
incompatible with modal scroll locking.

Production dependency resolution pins `fast-jwt` to `6.2.4`, eliminating all
known high and critical production advisories without changing
Superfunctions source. Lower-severity transitive advisories remain documented
when the affected code path is not part of the Cloudflare runtime.

Database backups are custom-format `pg_dump` artifacts accompanied by a
manifest containing the dump SHA-256, byte size, migration inventory, and
referenced R2 bundle inventory digest. Restore verifies the checksum before
touching the explicit target database, restores into a disposable target, and
then verifies migrations, tables, indexes, and referenced bundle metadata.

R2 orphan cleanup is age-gated and reference-aware. It deletes only old,
unreferenced digest objects and fails closed if object listing or the
Postgres reference query is incomplete. Published bytes and referenced
objects are never rewritten or deleted.

Accessibility semantics are part of the release contract: fatal route errors
use `role="alert"`, loading skeletons use a labeled `role="status"`, and
decorative policy icons are hidden from assistive technology.

Database schema verification requires every production index by name but does
not force a statistics-dependent `ORDER BY` into the public search probe. This
keeps restored small databases verifiable while the scale gate independently
records actual query plans.

## Consequences

- Security, accessibility, E2E, and visual suites are slower but deterministic
  and cannot conceal shared-state contamination.
- Backup corruption is detected before restore, and a manifest can reconcile
  every database version reference with R2 inventory.
- Cleanup prefers leaked storage over destructive ambiguity.
- Production scans fail on high/critical dependency advisories, fixture
  imports, assigned example secrets/IDs, leaked paths, or client secrets.
- Query-plan evidence reflects PostgreSQL's real planner choice at the tested
  scale instead of a forced plan.

## Rejected alternatives

- Parallel MCP security files against one database: trigger and fixture
  teardown can interfere and produce false results.
- A non-zero visual-diff allowance: it would turn deterministic dynamic or
  scroll state into hidden UI drift.
- Restoring an unchecked dump: corruption could be discovered only after the
  target database was replaced.
- Deleting objects when listing or references fail: incomplete knowledge must
  not destroy immutable skill history.
- Forcing an index in verification SQL: production plans must be measured,
  not manufactured.
- Broad Superfunctions dependency changes: the release issue was resolved
  with a workspace override and no external source modification.
