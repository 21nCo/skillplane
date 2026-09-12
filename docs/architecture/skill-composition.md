# Native skill composition and verification

Implements [SKI-3](https://linear.app/21n/issue/SKI-3/support-native-skill-composition-dependency-resolution-and). Format-v1 remains a leaf; its canonical bytes and content digest do not change. Format-v2 adds `entrypoints`, structured `dependencies`, optional `verification`, and the `verification/` file root. Examples in `examples/composition` are executable bundle fixtures, not published skills.

## Authoring and immutable identity

Each dependency declares `alias`, `workspace`, `skill`, a standard semantic-version range, `scope` (`execution`, `verification`, `both`), `mode` (`include`, `invoke`), optional `order`, and `required` (defaults to true). Every declared dependency must resolve; optional declarations are also locked and cannot silently disappear. Order ties sort by alias. Include activates a namespaced module. Invoke exposes a parent/alias/child handoff boundary in `executionPlan.invocations`; it grants no mutation authority. Instructions and assets retain their originating version identity and are never merged by filename.

Candidate creation resolves the highest compatible published direct versions, backtracking if their immutable transitive locks conflict. It never re-resolves a published child's own lock. A caller-supplied `skill.lock.json` is discarded and replaced. Amendments preserve the base lock; manifests and generated locks cannot be amended as files. Changing dependencies uses the composition candidate tool or the editor.

The lock contains exact version IDs, workspace/skill IDs and selectors, semantic versions, bundle digests, child closure digests, expanded sizes, and normalized edges. A lock omits its own root digest to avoid a circular hash. The closure digest is SHA-256 of canonical JSON `{rootDigest, lock}` after embedding the generated lock in the canonical root bundle. Leaf closure digests use the same algorithm with an empty lock. Dependency nodes and modules are ordered children before parents.

Publication checks the stored canonical lock against immutable normalized records and reauthorizes every locked node without choosing newer versions. Stale-base and existing serializable publication protection still apply. Compatible upgrades produce ordinary reviewable parent candidates. The editor, version page, MCP upgrade preview, and canonical file diff expose direct and transitive changes.

## Bounds and authorization

Default policy: maximum depth 12, fan-out 32, 128 distinct dependency nodes, 50 MiB expanded closure, 100 direct-version alternatives and 4,096 resolution search attempts. Version-alternative content is also bounded to 50 MiB per direct search. Exact constraints query exact versions. `COMPOSITION_LIMITS` is the server policy; callers cannot increase it. Cycles, conflicting immutable pins, missing or inaccessible dependencies, and invalid ranges return `SKILL_DEPENDENCY_CONFLICT`. Inaccessible identities are redacted; accessible graph failures carry a path.

Private cross-workspace dependencies are forbidden. A public parent requires a fully public closure; workspace-visible parents cannot include private children. Private parents can use authorized same-workspace skills and public cross-workspace skills. Every node is checked at creation, publication and retrieval, including legacy bundle/file retrieval of a composite. Global public projections supply cross-region public bundles; regional private data never gets copied into a public closure. Bundle content may be cached immutably, but authorization and emergency invalidation are checked live.

Deprecation leaves exact pins readable with warnings. Revocation is monotonic and blocks roots and dependents. An independent control-plane lifecycle record invalidates public copies without waiting for projection delivery. Invalidation is written first; a regional/audit failure can leave a safe invalidation in place and the idempotent request can be retried. Workspace archive behavior remains governed by the existing catalog: same-workspace pins can resolve while archived; withdrawn public projections stay inaccessible. Revocation is separate from archive and cannot be undone by restore.

## Verification contract

`verification/claims.json` is an array of stable claim IDs with statement, blocking/advisory severity, scope, required evidence types, prohibited bypasses, explicit pass/fail/unknown rules, and an optional verifier procedure. Verification entrypoint and claims must be declared together. Blocking child claims are inherited even through execution dependencies. Identity is `originatingVersionId/claimId`, so parent claims cannot replace child claims. No implicit waivers are accepted.

A verifier independently retrieves the verification plan, then starts a run against the exact closure, repository commit and environment. Its authenticated principal and declared agent/model are recorded. The declared executor identity must differ from the verifier. This is an attribution boundary, not proof that the caller's declared executor is accurate. Evidence is independently assessed by the verifier; the server validates the evidence contract, not the truth of arbitrary external observations.

Evidence is bounded, redacted metadata containing HTTPS or URN references and SHA-256 digests. Raw evidence is not uploaded to Skillplane. References must omit credentials and query tokens. Evidence content remains in the caller's access-controlled store; references and explanations are private to the root workspace, expire from read access after 90 days, and are never included in public projections. Only the original verifier may update a running run. All mutation operations use existing idempotency and principal audit attribution. Completion hashes the evidence manifest with closure, commit, environment and verifier. Blocking fail produces fail; missing/unknown blocking claims or required evidence produce unknown. Advisory unknowns remain visible without blocking.

The DataFn reference requires complete read/mutation inventories, call-path tracing, bypass scans, representative runtime evidence, successful/failing mutation tests and tenant/authorization checks. Package installation or scaffolding cannot satisfy its claims. Any unaccounted surface is blocking unknown.

## API and MCP

- `skill_resolve`: exact root selection, dependency DAG, execution modules, invocation edges and verification plan.
- `skill_retrieve`: unchanged leaf shape; v2 adds `composition`.
- `skill_composition_candidate_create`: author dependencies and verifier files against a base version.
- `skill_dependency_upgrades_get`, `skill_dependency_upgrade`: preview and create a reviewable upgrade.
- `skill_verification_plan_get`, `skill_verification_run_start`, `skill_verification_evidence_add`, `skill_verification_run_complete`, `skill_verification_run_get`.
- `skill_version_lifecycle_update`: owner/admin deprecation or revocation.

HTTP equivalents live below `/api/v1/skills/:skillId/versions/:versionId` (`resolve`, `dependency-upgrade`, `verification-runs`, `lifecycle`, `dependents`) and `/api/v1/skills/:skillId/verification-runs/:runId` (`evidence`, `complete`). Evidence and run reads require workspace authentication. Dependents are scoped to the current workspace to prevent leaking private parent identities.

## Migration, validation and rollout

Apply regional migrations 0048/0050 and control migrations 0049/0051 before activating v2 writers. Set `SKILL_COMPOSITION_WRITES_ENABLED=false` to disable v2 creation/publication while retaining v2 reads. Historical versions need no bundle rewrite: v1 composition metadata is derived at read time; v2 metadata and normalized edges are immutable companion records. New regional tables participate in workspace migration fences and namespace movement. Control-plane invalidations remain global. Public visibility withdrawal records the regional projection sequence cutoff before changing visibility: replayed stale events cannot restore access, even if processed later. Only a causally newer public projection can restore it.

Run `DATABASE_URL=<regional-database-url> node scripts/verification-retention.mjs` from a scheduled regional maintenance job. Each invocation deletes at most 500 expired runs and their evidence in one transaction. It skips migrating workspaces and holds each active workspace routing epoch so moved workspaces can still expire records safely. Database triggers freeze completed results and targets, and allow deletion only after expiry.

Build reference ZIPs with `pnpm --filter @skillplane/storage build && node scripts/build-composition-examples.mjs`. Publish fixtures only in a disposable `examples` workspace, in dependency order: `use-ui`, `use-auth`, `use-datafn`, `company-stack`, `create-linear-issue`, then the two Linear parents. The Linear reference module requires explicit authorization before writes.

Run unit and negative resolver/verification fixtures, then the Postgres lifecycle suite against an explicitly provisioned local test database:

```sh
TEST_DATABASE_URL="$DISPOSABLE_TEST_DATABASE_URL" pnpm exec vitest run packages/domain/tests/integration/composition.integration.test.ts
```

The suite does not reset or delete a database; it creates uniquely named fixtures. Production canaries require deploying readers and migrations first, then enabling writers and publishing the reference composites. Rollback must retain v2 readers; disabling composition writes must not erase existing locks or verification history.
