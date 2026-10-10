# DECISION-0006 — Audit retention and analytics rollups

- Date: `2026-07-26`
- Status: accepted
- Scope: PHASE_13 audit, retention, analytics, and product views

## Decision

Skillplane uses one central audit writer and two explicit retention classes:

- `detailed_read_90d` for attributable retrieval detail;
- `permanent` for mutations, publication, membership, authorization, OAuth
  security, and retention execution.

Audit inserts are redacted before persistence and validated again by
Postgres. Audit rows are immutable. Deletion is allowed only for eligible
detailed reads, only after 90 days, and only while the retention job enables
its transaction-local database guard.

Daily UTC analytics are permanent Postgres rollups. A run takes an advisory
lock per workspace/day, removes only that day's derived rows, recomputes
summary and dimension rows from audit detail, and records the completed
source-event count in the same transaction. Retention recomputes every
affected day before deleting detail, so aggregate counts survive expiry.

The product reads only the permanent rollup tables for analytics. Detailed
audit endpoints remain owner/admin-only, are tenant-scoped, use signed opaque
cursors, apply bounded filters, and return redacted records or redacted CSV.
Authenticated principals and credentials are labeled separately from
caller-declared agent, model, client, and run fields.

## Consequences

- Replaying a rollup replaces the same derived day instead of incrementing it.
- Interrupted retention is restartable in bounded `SKIP LOCKED` batches.
- Permanent history cannot be removed by application SQL or the retention
  path.
- Aggregate reports remain useful after detailed retrieval expiry.
- Prompts, skill/context bodies, OTPs, emails, credentials, and arbitrary
  exception messages do not enter durable audit, rollups, exports, or
  operational logs.
- Analytics and audit responses use `private, no-store`; no authorization
  decision or mutable private response is cached.

## Rejected alternatives

- Incremental counters on every read: retries and partial failures make
  reconciliation and historical correction unreliable.
- Deleting detail before aggregation: a failed rollup would permanently lose
  analytic facts.
- A single permanent audit class: this would retain detailed access history
  beyond the accepted privacy window.
- Treating caller declarations as authenticated identity: declared agent and
  model fields are useful dimensions but are not proof of the caller.
