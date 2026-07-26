# DECISION-0007 — Public discovery and cache contract

- Date: `2026-07-26`
- Status: accepted
- Scope: PHASE_14 landing, public skill discovery, and public artifacts

## Decision

Skillplane exposes anonymous public discovery through a dedicated API that
applies the public, active, and published filters inside the materialized
authorization query before full-text ranking. Empty-query browsing and
full-text search share deterministic score-plus-ID ordering and HMAC-signed,
filter-bound, expiring cursors.

The public web surface renders only the current published version, sanitized
`SKILL.md`, and published version history. Candidate versions, learning
metadata, caller declarations, contexts, notes, audit records, archived
skills, and non-public skills do not enter public responses.

Cache behavior is split by mutability:

- public directory, current pointer, published history, and SSR HTML use
  `public, max-age=0, must-revalidate`;
- version-and-digest-addressed public files use
  `public, max-age=31536000, immutable` and a file-digest ETag;
- authenticated, private, and mutable workspace responses remain
  `private, no-store`.

Origin handlers re-evaluate public visibility before serving current,
history, or digest routes. A new publication changes the current digest ETag
without overwriting any immutable artifact.

## Consequences

- Anonymous discovery cannot rank or leak private, workspace, archived,
  candidate, context, note, or audit content.
- Signed cursors cannot be reused with different queries, tags, visibility,
  archive state, or authorization scope.
- Current pages revalidate immediately after publication or visibility
  changes.
- A digest URL that was previously served publicly is intentionally treated
  as an immutable published artifact and can remain in intermediary caches
  for its cache lifetime; retracting already-public bytes is not promised.
- The sitemap fails closed if pagination repeats or exceeds its bounded
  10,000-skill generation limit.

## Rejected alternatives

- Caching a mutable current pointer as immutable: this would serve stale
  releases after publication.
- Ranking before authorization filtering: this can leak protected document
  existence and ranking signals.
- Publishing context knowledge or candidate history: public visibility is for
  approved skill content, not workspace learning state.
- Client-only discovery: server rendering is required for crawlability,
  canonical metadata, deterministic failures, and accessible initial content.
