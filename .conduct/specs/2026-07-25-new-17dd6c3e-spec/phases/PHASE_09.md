# PHASE_09 — Amendments, learning metadata, and review

## Phase goal

Implement controlled human and agent skill amendments with structured learning provenance, policy evaluation, candidate review, and safe publication.

## In scope

- Learning metadata schemas and validation.
- File-operation amendment engine.
- Candidate versions.
- Review-required and trusted auto-publication policies.
- Approval/rejection and publication.
- Diff/provenance review UI.

## Out of scope

- MCP transport.
- OAuth.
- Analytics aggregation.

## Deliverables

- `packages/domain/src/learning-metadata.ts`
- `packages/domain/src/amendments.ts`
- `packages/domain/src/amendment-policy.ts`
- `packages/domain/src/reviews.ts`
- `packages/api/src/routes/amendments.ts`
- `packages/api/src/routes/reviews.ts`
- DataFn candidate/review resource additions
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/candidates/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/candidates/[versionId]/+page.svelte`
- `app/src/lib/amendments/LearningMetadata.svelte`
- `app/src/lib/amendments/ReviewDecision.svelte`
- `app/src/lib/amendments/PolicyEditor.svelte`
- policy/concurrency/E2E tests and screenshots
- engineering log, phase report, and ledger append

## Requirements covered

- `SKL-006`
- `SKL-007`
- `SKL-008`
- `CTX-004`
- `AUTH-004`
- `AUTH-008`
- `UI-002`
- `UI-005`
- `QA-001`
- `QA-002`
- `QA-004`

## Implementation tasks

1. Implement exact learning metadata schema, bounds, normalization, and redaction.
2. Implement deterministic add/replace/delete operations using base version and expected digests.
3. Re-run full bundle canonicalization and validation before candidate creation.
4. Implement candidate persistence, idempotency, revision numbering, and R2 transaction semantics.
5. Implement default review-required policy and trusted credential rules for scopes, bump, context, and daily limit.
6. Implement approval/rejection, reason, reviewer attribution, and publish-time semver conflict.
7. Build candidate list/review/diff/provenance/policy UI.
8. Clearly label authenticated principal and caller-declared agent/model.
9. Verify context-sourced learning can be referenced without mutating the context.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/domain -- amendments learning-metadata policies
pnpm test:integration --filter amendments
pnpm test:security --filter amendment-policy
pnpm test:e2e --grep @amendments
pnpm test:visual --filter amendment-review
```

Expected outcomes:

- Valid amend creates one immutable candidate.
- Unsafe, stale, or invalid amendments create nothing.
- Review and auto-publication paths are policy-correct.
- UI shows diff, learning, evidence, validation, context, and provenance.

## Stop condition

Report candidate/review workflows, policy matrix, semver conflict test, and review screenshots before `PHASE_10`.
