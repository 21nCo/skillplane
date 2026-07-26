# PHASE_09 engineering log

- Started: `2026-07-26T10:18:00Z`
- Completed: `2026-07-26T11:11:16Z`
- Status: `COMPLETE — PASS`
- Scope: structured learning provenance, deterministic agent amendments,
  candidate review, trusted auto-publication policy, semver-safe publication,
  tenant-safe Hono/DataFn access, and persisted review UI.

## Implemented

1. Added strict learning metadata with required summary, observation,
   rationale, confidence, evidence or an explicit absence reason, validation
   or an explicit not-run reason, tags, external references, context
   provenance, and bounded extra JSON.
2. Added secret-like key/value rejection, depth/key/byte limits, canonical
   normalization, and precise field errors for learning records.
3. Added deterministic add/replace/delete amendment operations. Every
   replace/delete verifies the expected SHA-256 digest, direct `skill.json`
   mutation is rejected, and the resulting bundle is fully canonicalized and
   validated before persistence.
4. Added immutable candidate versions with exact idempotency replay,
   caller-declared agent/model/client/run/session/conversation/user
   attribution, authenticated principal attribution, content-addressed R2
   storage, provenance operations without raw file contents, and audit events.
5. Added skill amendment policy with a review-required default and ordered
   trusted-auto-publish rules over service credential, independent
   `skills:amend` scope, maximum semver bump, allowed source contexts, and
   daily publication limit.
6. Added immutable review records and admin/owner approval or rejection with a
   mandatory rationale. Approval assigns semver and updates the current
   release in one serializable transaction.
7. Added list/detail/decision/policy Hono routes and tenant-filtered DataFn
   candidate/review fields. Public version responses intentionally omit
   private learning and caller attribution.
8. Added candidate inventory, review detail, identity boundary, exact diff,
   deterministic operations, context-backed learning, review decision, and
   policy matrix UI using the existing Svelte/Tailwind/Phosphor design system.
9. Added domain, integration, security, persisted-browser, and visual tests,
   including one-time service credentials and simultaneous approvals.
10. Added migration `0010_amendments_reviews.sql` for candidate provenance,
    caller declaration, policy decision, reviewer identity, constraints, and
    indexes.

## Amendment and review invariants

- An accepted amend request creates the immutable candidate and review before
  any publication outcome is exposed.
- A stale base, wrong digest, unsupported operation, invalid learning record,
  wrong context, outsider lookup, or viewer request creates no candidate.
- Same-key/same-payload replay returns the original result even after
  auto-publication. Same-key/different-payload reuse returns
  `IDEMPOTENCY_KEY_REUSED`.
- User callers cannot declare another user. Service callers must name a real
  workspace member and retain their own authenticated service identity.
- Context provenance captures the current immutable context revision and
  digest without changing context knowledge.
- Auto-publication requires every condition in one trusted rule. A missing
  scope, wrong credential/context, excessive bump, or exhausted daily limit
  falls back to review.
- Simultaneous approvals of two candidates based on one release produce one
  published `1.0.3` winner and one `SKILL_VERSION_CONFLICT`; the losing
  candidate and review remain pending.

## Regression defects found and closed

- Anonymous public search supplied the workspace-only archive argument to a
  seven-parameter query. Public and workspace searches now supply the exact
  parameter count, and the full security suite passes.
- Schema integration tests had hard-coded eight migrations and omitted the
  Phase 08 context digest. They now derive the migration count and construct a
  valid immutable context revision.
- Test fixture cleanup used relation-wide `ALTER TABLE ... DISABLE TRIGGER`
  statements, which could deadlock another tenant's writes. Cleanup now
  disables triggers only in its local session while explicitly removing
  immutable leaves before normal cascades resume.
- Serializable operations could exhaust two immediate retries during
  parallel integration traffic. Domain and database transaction helpers now
  use five bounded retries with exponential jitter for SQLSTATE `40001` and
  `40P01`.
- Initial review screenshots exposed an overlapping decision panel, uneven
  policy controls, and duplicated `user:user:` labels. The final layout and
  identity rendering were corrected and recaptured.

## Final verification

```text
pnpm test:unit --filter @skillplane/domain -- amendments learning-metadata policies
PASS — 3 files, 13 tests

pnpm test:integration --filter amendments
PASS — 1 comprehensive API/DataFn/concurrency scenario

pnpm test:security --filter amendment-policy
PASS — 1 file, 4 tests

pnpm test:e2e --grep @amendments
PASS — 1 persisted browser workflow

pnpm test:visual --filter amendment-review
PASS — 1 workflow, 5 narrative screenshots

pnpm test:integration
PASS — 18/18 workspace tasks; API 7 files, 22 tests

pnpm test:security
PASS — email, auth, DataFn, and API; API 5 files, 16 tests

pnpm lint
PASS

pnpm typecheck
PASS — 23/23 tasks, zero Svelte warnings

pnpm format:check
PASS

pnpm boundaries:verify
PASS — WORKSPACE_BOUNDARIES_VALID

pnpm lint:design-system
PASS — DESIGN_SYSTEM_POLICY_PASSED

pnpm client-secrets:verify
PASS — CLIENT_BUNDLES_SECRET_FREE

pnpm build
PASS — 13/13 package builds, including Cloudflare Worker dry-runs
```

## External boundaries

No Superfunctions worktree or source file was modified in PHASE_09.
