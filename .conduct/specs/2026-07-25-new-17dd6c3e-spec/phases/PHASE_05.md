# PHASE_05 — Skill bundles, R2, versions, and search

## Phase goal

Implement secure deterministic skill bundles, immutable versioning, R2 persistence, release pointers, and authorization-safe full-text search.

## In scope

- Bundle manifest and validation.
- Deterministic archive canonicalization.
- R2 repository and cleanup.
- Skill/version domain services.
- Semantic version publication.
- Archive/restore.
- Postgres full-text index and search.

## Out of scope

- Feature UI.
- Contexts.
- Agent amendment policies.

## Deliverables

- `packages/storage/src/manifest.ts`
- `packages/storage/src/paths.ts`
- `packages/storage/src/canonicalize.ts`
- `packages/storage/src/validate.ts`
- `packages/storage/src/r2.ts`
- `packages/storage/src/downloads.ts`
- `packages/storage/src/index.ts`
- `packages/domain/src/skills.ts`
- `packages/domain/src/skill-versions.ts`
- `packages/domain/src/publication.ts`
- `packages/domain/src/search.ts`
- `packages/domain/src/idempotency.ts`
- `packages/api/src/routes/skills.ts`
- `packages/api/src/routes/skill-versions.ts`
- `packages/api/src/routes/search.ts`
- database migration for full-text generated/indexed fields
- storage/domain/security tests and fixtures
- engineering log, phase report, and ledger append

## Requirements covered

- `DATA-004`
- `TEN-003`
- `SKL-001`
- `SKL-002`
- `SKL-003`
- `SKL-004`
- `SKL-005`
- `SKL-009`
- `SKL-010`
- `OPS-005`
- `OPS-006`
- `QA-001`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Define `skill.json` format version 1 and validate it with exact schemas.
2. Implement streaming archive inspection with all path, link, duplicate, file-count, size, and expansion checks.
3. Produce deterministic canonical ZIP bytes and digest.
4. Implement content-addressed R2 writes, conditional reads, metadata, and safe orphan cleanup.
5. Implement create skill, create revision, publish, archive, restore, file retrieval, and diff services.
6. Implement Postgres transaction boundaries for R2-first/database-second writes and cleanup.
7. Implement revision numbering and publish-time semantic version conflicts.
8. Implement visibility-aware full-text search and opaque cursors.
9. Add property-based canonicalization tests and concurrent publication tests.
10. Verify R2 failure never substitutes content or leaves a visible partial record.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/storage --filter @skillplane/domain
pnpm test:integration --filter skill-storage
pnpm test:security --filter bundle
pnpm test:security --filter tenant-search
pnpm test:integration --filter publication-concurrency
pnpm db:verify
```

Expected outcomes:

- Canonical bundle fixtures are byte-identical.
- Malicious archives fail before persistent writes.
- Concurrent publication produces one winner.
- Full-text search does not leak unauthorized counts or scores.
- Orphan cleanup preserves referenced objects.

## Stop condition

Report canonical fixture digests, R2 object inventory, concurrency results, and search isolation evidence before `PHASE_06`.
