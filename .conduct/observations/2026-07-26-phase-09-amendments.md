# PHASE_09 amendment and review observations

## Candidate workflow

The candidate inventory treats every agent improvement as an inspectable
review object, including trusted auto-publications. Status totals and filters
separate pending, approved, and rejected history. Each row names the candidate
revision, proposed bump, declared agent/model, authenticated actor type and
identity, declared user, and creation time.

The review detail deliberately separates the authenticated requester from the
caller-declared agent. This makes a server-derived user or service principal
visually distinct from claims such as agent name, model, MCP client, run ID,
and for-user attribution.

The decision panel appears before the evidence because approval is the primary
task. It remains in document flow and does not cover learning provenance.
Viewers see the same evidence and exact diff with an explicit admin/owner
requirement instead of mutation controls.

## Learning and provenance

Learning metadata is presented as a first-class record:

- summary and confidence;
- observation and rationale;
- individually typed evidence and validation;
- immutable source context revision and digest;
- tags, external references, and optional bounded extra metadata.

Deterministic operations show operation, normalized path, expected digest, and
result digest without exposing raw request content. The exact bundle diff
remains the authoritative human-review surface.

The browser fixture linked a repository context to the candidate. Approval and
reload preserved the captured context revision/digest while the context's own
current knowledge pointer remained unchanged.

## Policy behavior

Review-required is the safe default. Trusted auto-publish is visually and
semantically an ordered matrix: credential, maximum bump, daily cap, and
allowed source contexts must all match within one row. Empty context
selection intentionally permits requests with or without a source context.

The browser saved a trusted rule, reloaded settings, and recovered the exact
credential, patch-only bump, daily limit, and repository context selection.
Service-principal security tests independently proved that missing scope,
wrong context, an excessive bump, and the daily cap all return to review.

## Concurrency

Two pending candidates were produced from the same `1.0.2` base, then approved
simultaneously. Exactly one became published `1.0.3`. The other request
received a typed conflict, and its candidate/review remained pending and
inspectable. No losing review was partially resolved.

Parallel repository integration initially revealed serializable retry pressure
and relation-wide fixture-cleanup locks. Bounded retry/backoff and session-local
cleanup removed the nondeterminism; the full integration suite subsequently
passed with all API files running together.

## Narrative screenshot index

| Screenshot | Observation |
|---|---|
| `amendment-candidates-pending-desktop.png` | pending totals, declared agent/model, authenticated user, and declared user are distinct |
| `amendment-review-detail-desktop.png` | decision, learning, context provenance, deterministic operation, and exact diff fit one clear review flow |
| `amendment-review-viewer-readonly.png` | viewer receives all evidence with an explicit role boundary and no mutation controls |
| `amendment-review-approved-reload.png` | immutable rationale, reviewer identity, approved state, and exact diff survive reload |
| `amendment-policy-matrix-desktop.png` | trusted credential, patch cap, daily limit, and repository context align as one rule |

Manual inspection found no clipped primary action, overlapping panel, ambiguous
identity prefix, misaligned policy control, or horizontal overflow in the final
captures. The visual hierarchy remains consistent with the restrained
Linear-inspired system established in PHASE_06.
