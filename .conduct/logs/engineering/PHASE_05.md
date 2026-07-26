# PHASE_05 engineering log

- Started: `2026-07-26T07:13:00Z`
- Completed: `2026-07-26T07:56:53Z`
- Status: `COMPLETE — PASS`
- Scope: deterministic skill bundles, private content-addressed R2 persistence,
  immutable versions, publication, lifecycle, and authorization-safe full-text
  search.

## Implemented

1. Added strict `skill.json` format version 1 schemas, normalized path handling,
   deterministic JSON, media types, and complete canonical database manifests.
2. Added central-directory-first ZIP inspection and streaming extraction with
   compressed, expanded, per-file, file-count, path-byte, UTF-8, traversal,
   case-fold collision, encryption, compression, ZIP64, symlink, hard-link,
   device, and expansion-ratio rejection.
3. Added deterministic canonical ZIP output using bytewise path order, fixed
   timestamp/mode, stable compression, and SHA-256 content addressing.
4. Added private R2 writes with conditional create, full-byte collision
   verification, digest-verified reads, R2 availability checks, post-
   authorization digest caching, paginated inventory, and fail-closed orphan
   cleanup.
5. Added skill creation with initial published `1.0.0`, candidate revision
   reservation, semantic publication, rejection, file retrieval, bounded text
   diffing, visibility, archive, restore, and principal-scoped idempotency.
6. Added R2-first/Postgres-second transactions with same-transaction audit and
   idempotency completion, plus safe orphan removal after database failure.
7. Added migration `0008_skill_bundles_search.sql` for nullable candidate
   semantic versions, immutable base relationships, R2 metadata, monotonic
   revision allocation, scoped idempotency, generated search documents,
   context refresh, and partial GIN indexes.
8. Added Hono endpoints for ZIP/base64 uploads, skill/version lifecycle,
   candidate approval/rejection, verified files, diffs, and public/workspace
   search. Internal R2 keys are never serialized.
9. Added signed, expiring, filter-bound search cursors and a materialized
   authorization CTE before ranking. Public documents exclude private context
   terms and candidate content.
10. Added production recovery instructions and executable local R2 inventory/
    cleanup rehearsal.

## Limits enforced

| Boundary | Limit |
|---|---:|
| Compressed ZIP | 10 MiB |
| Expanded ZIP | 25 MiB |
| Files | 1,000 |
| Per file | 5 MiB |
| `SKILL.md` | 1 MiB |
| Normalized path | 240 UTF-8 bytes |

## Canonical fixtures

| Fixture | Digest | Bytes |
|---|---|---:|
| Minimal | `sha256:89a1ce5aedcab433c01bee721e93fd9a989a0bc4aa8ab4f54c4d4cb21bae376f` | 465 |
| Portable | `sha256:c80839837c5bad80842caf1035ff26b82c9a0836c5416cf96ad797c64c24a972` | 900 |

The property suite reproduced identical bytes across 75 generated inventories
with reordered paths and different timestamps.

## R2 and database transaction evidence

- Create, replay, and duplicate-slug attempts left one referenced canonical R2
  key and one published database version.
- A forced R2 write failure committed no visible skill/version.
- Cleanup listed the complete inventory, deleted one explicit old orphan,
  preserved the referenced object, and ended with one object.
- Cleanup preserved all objects when listing or database reference collection
  was uncertain.
- Digest cache hits still perform an R2 `head` availability check and re-hash
  cached bytes. Removing the R2 object returns `R2_READ_FAILED` even when the
  digest cache contains bytes.

## Version and publication evidence

- The initial version is revision 1 and semantic version `1.0.0`.
- A candidate R2 failure after committed revision reservation left revision 2
  unused. The next successful candidates were revisions 3 and 4.
- Two concurrent approvals from the same base returned statuses `200` and
  `409`; exactly one candidate became `1.0.1`, the pointer selected that winner,
  and the loser remained pending.
- Rejecting the loser preserved its original change summary and stored the
  decision reason in an immutable audit event.
- Published-row trigger coverage rejects direct content/metadata mutation.

## Search isolation evidence

- Workspace A ranking returned only A's private/public skills and never public
  or private rows from workspace B.
- Anonymous ranking returned only published public releases.
- Candidate-only instructions and context-only terms were absent from public
  search; authorized workspace search included allowed context metadata.
- Repeated queries returned identical ranking order.
- Signed cursor paging returned the next unique row; changed filters returned
  `CURSOR_FILTER_MISMATCH`; signature and non-canonical base64url tampering
  returned `CURSOR_INVALID`.
- Database verification used `skills_public_search_idx` and
  `skills_workspace_search_idx`.

## Defects found and closed

- Hono wildcard routes matched but did not expose the wildcard parameter. The
  file route now uses a named multi-segment parameter.
- Anonymous search initially left SQL parameter `$1` untyped. Public
  authorization now explicitly types and checks the null scope parameter.
- Changing unused base64url tail bits could produce an alternate cursor string
  with identical decoded signature bytes. Cursor decoding now requires
  canonical base64url.
- Rejecting a candidate initially overwrote its change summary. Rejection now
  preserves candidate metadata and records the reason in audit.
- The workspace-constrained search plan legitimately preferred its tenant
  B-tree on the small fixture. The verifier now separately proves each partial
  GIN index is usable.
- Published test fixtures made ordinary cascading cleanup hit production
  immutability triggers. Test-only cleanup disables only user triggers inside a
  transaction while preserving FK/constraint triggers.
- Potentially active SVG, PDF, HTML, and JavaScript file responses are now
  sandboxed and forced to attachment disposition.

## Final verification

```text
pnpm test:unit --filter @skillplane/storage --filter @skillplane/domain
PASS — storage 15/15; domain 11/11

pnpm test:integration --filter skill-storage
PASS — 6/6

pnpm test:security --filter bundle
PASS — 4/4

pnpm test:security --filter tenant-search
PASS — 5/5

pnpm test:integration --filter publication-concurrency
PASS — 1/1

pnpm db:verify
PASS — 21 tables, 8 migration hashes, both skill-search GIN indexes
```

Supplemental final-source verification also passed all API integration tests
(19), API security tests (11), database integration tests (4), and relevant
package typechecks.

## External boundaries

No Superfunctions worktree or source file was modified in PHASE_05.
