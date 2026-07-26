# PHASE_05 skill storage observations

## Canonical fixture digest inventory

| Fixture | SHA-256 content address | Canonical bytes |
|---|---|---:|
| Minimal | `sha256:89a1ce5aedcab433c01bee721e93fd9a989a0bc4aa8ab4f54c4d4cb21bae376f` | 465 |
| Portable | `sha256:c80839837c5bad80842caf1035ff26b82c9a0836c5416cf96ad797c64c24a972` | 900 |

The stored key shape is:

```text
workspaces/{workspaceId}/skills/{skillId}/bundles/sha256/{digest}.zip
```

The bucket remains private. Database/API responses expose the digest and
manifest but never expose the R2 object key as a public URL.

## R2 inventory rehearsal

The storage integration created and idempotently replayed one skill. Duplicate
slug failure and malformed/R2-failed uploads added no visible row or retained
object. The inventory then contained one referenced canonical bundle.

The cleanup rehearsal added one explicit orphan and used a complete database
reference set. Result:

```text
scanned:   2
deleted:   1 explicit orphan
preserved: 1 referenced bundle
final:     1 referenced bundle
```

Database or R2-list uncertainty produces `R2_CLEANUP_FAILED` before deletion.
Digest-cached bytes are used only after an R2 availability check and their
SHA-256 is recomputed.

## Publication concurrency

One forced R2 failure occurred after revision 2 was reserved. The successful
database inventory was revisions `1`, `3`, and `4`; revision 2 was never reused.
Concurrent approval of revisions 3 and 4 produced exactly one `1.0.1` winner,
one `SKILL_PUBLISH_CONFLICT`, one current release pointer, and three immutable
R2 objects. The losing candidate remained reviewable.

## Search isolation

- Workspace A saw only its own private/public releases.
- Anonymous search saw public published releases from A and B.
- B's private rows never contributed result rows, counts, or scores to A.
- Public search excluded candidate instructions and context metadata.
- Workspace search included allowed context names/descriptions.
- Ranking order repeated exactly; stable IDs break equal-score ties.
- Cursor filter changes, signature changes, and alternate non-canonical
  base64url encodings were rejected.

The database verifier confirmed both `skills_public_search_idx` and
`skills_workspace_search_idx`.

## UI evidence

PHASE_05 explicitly excludes feature UI, so no screenshot was created. The
backend observations above are automated artifact evidence for the later skill
management and public-discovery UI phases.
