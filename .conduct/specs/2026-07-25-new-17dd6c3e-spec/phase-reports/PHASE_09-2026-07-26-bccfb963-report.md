# PHASE_09 completion report

## Metadata

| Field | Value |
|---|---|
| Timestamp | `2026-07-26T11:11:16Z` |
| Agent | `unknown-agent` |
| Model | `GPT-5` |
| Launcher | `Codex Desktop` |
| Workspace | repository root |
| Environment | `Darwin arm64`, shell `zsh` |
| Git | branch `main`; no commit yet; repository working tree contains the implementation |

## Phase

`PHASE_09` — Amendments, learning metadata, and review

## Status

**PASS**

Controlled human and agent amendments, structured learning provenance,
immutable candidates, review-required and trusted auto-publication policies,
semver-safe decisions, audit identity separation, tenant-safe APIs, and the
persisted review UI are implemented and verified.

## Requirements delivered

`SKL-006`, `SKL-007`, `SKL-008`, `CTX-004`, `AUTH-004`, `AUTH-008`, `UI-002`,
`UI-005`, `QA-001`, `QA-002`, and `QA-004`.

### Learning metadata — PASS

- Requires summary, observation, rationale, confidence, and evidence or a
  documented absence reason.
- Requires validation entries or a documented not-run reason.
- Supports source context provenance, tags, external references, and bounded
  additional JSON.
- Rejects secret-like keys/values, excessive depth, more than 200 extra keys,
  oversized strings, and extra metadata above 32 KiB.

### Deterministic amendments — PASS

- Add, replace, and delete use normalized paths and exact expected SHA-256
  digests.
- Direct `skill.json` changes are rejected, and complete canonical bundle
  validation runs before candidate persistence.
- Exact idempotent replay returns the original result; changed-payload reuse
  is rejected.
- R2 objects are content-addressed, and failed database persistence is
  compensated without leaving an accepted candidate.
- Stored provenance contains operations and digests, never raw amendment file
  content.

### Identity, authorization, and audit — PASS

- Authenticated user/service identity is stored separately from declared
  agent, model, client, run, session, conversation, and for-user details.
- Users cannot impersonate another user. Services must declare an existing
  workspace member.
- Viewer mutation attempts fail before database or R2 writes.
- Tenant outsiders receive non-leaking `404` responses.
- Audit records retain authenticated actor, declared agent/model/user,
  context, policy outcome, and request identity.

### Policy and review — PASS

- The default is review required.
- Trusted auto-publication requires a service principal, independent
  `skills:amend` scope, matching credential, allowed bump, allowed context, and
  remaining daily capacity.
- Every candidate has an immutable review record, including auto-publications.
- Admin/owner decisions require a rationale and publish atomically.
- Two concurrent approvals based on one release produce one `1.0.3` winner;
  the loser receives a typed conflict and remains pending.

### UI — PASS

- Candidate inventory provides status totals/filtering and complete actor vs
  caller attribution.
- Review detail presents decision controls, learning narrative, evidence,
  validation, captured context revision/digest, deterministic operations, and
  exact bundle diff.
- Viewer state is fully readable but non-mutating.
- Policy settings edit multiple trusted rules and persist/reload credential,
  maximum bump, daily cap, and context selection.
- Version detail presents retained learning metadata for agent amendments.

## Acceptance evidence

| Scenario | Result |
|---|---|
| valid amend | one immutable candidate and review |
| same-key exact replay | original candidate returned |
| same-key changed request | `IDEMPOTENCY_KEY_REUSED` |
| stale base / wrong file digest | conflict; no candidate |
| wrong-skill context | `CONTEXT_NOT_FOUND` |
| outsider resource access | non-leaking `404` |
| viewer amendment | `403`; no database/R2 mutation |
| user impersonation | rejected |
| service for-user outsider | rejected |
| admin approval | published and reload-persistent |
| trusted service rule match | auto-published with immutable approved review |
| rule mismatch / daily cap | pending review |
| simultaneous approval | one `200`, one `409`; loser stays pending |
| context-backed learning | captured revision/digest; context unchanged |
| public version read | private learning/caller fields omitted |

## Deliverables summary

### Database/domain/API

- `packages/db/migrations/0010_amendments_reviews.sql`
- `packages/domain/src/learning-metadata.ts`
- `packages/domain/src/amendments.ts`
- `packages/domain/src/amendment-policy.ts`
- `packages/domain/src/reviews.ts`
- `packages/api/src/routes/amendments.ts`
- `packages/api/src/routes/reviews.ts`
- Candidate/review additions in `packages/datafn/src/schema.ts`

### Application

- Candidate list and review detail routes under the authenticated skill tree
- `LearningMetadata.svelte`, `ReviewDecision.svelte`, and `PolicyEditor.svelte`
  in the skill application library
- Candidate navigation and policy settings integrated into skill detail

### Tests and evidence

- Domain learning, amendment, and policy suites
- Comprehensive amendment API/DataFn/concurrency integration suite
- Amendment-policy security suite
- Persisted Playwright amendment/review/policy workflow
- Five manually inspected screenshots under `.conduct/screenshots/phase-09/`

No production source file was deleted. No Superfunctions file was changed.

## Verification summary

| Command | Result |
|---|---|
| `pnpm test:unit --filter @skillplane/domain -- amendments learning-metadata policies` | PASS — 3 files, 13 tests |
| `pnpm test:integration --filter amendments` | PASS — 1/1 |
| `pnpm test:security --filter amendment-policy` | PASS — 4/4 |
| `pnpm test:e2e --grep @amendments` | PASS — 1/1 |
| `pnpm test:visual --filter amendment-review` | PASS — 1/1 and five captures |
| `pnpm test:integration` | PASS — 18/18 tasks; API 22/22 |
| `pnpm test:security` | PASS — API 16/16 plus auth/DataFn/email |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS — 23/23 tasks, zero warnings |
| `pnpm format:check` | PASS |
| `pnpm boundaries:verify` | PASS |
| `pnpm lint:design-system` | PASS |
| `pnpm client-secrets:verify` | PASS |
| `pnpm build` | PASS — 13/13 package builds |

## Screenshot index

1. `amendment-candidates-pending-desktop.png`
2. `amendment-review-detail-desktop.png`
3. `amendment-review-viewer-readonly.png`
4. `amendment-review-approved-reload.png`
5. `amendment-policy-matrix-desktop.png`

## Remaining risks and scope

1. MCP amendment/retrieval transport is intentionally outside PHASE_09.
2. OAuth authorization-server integration is intentionally outside PHASE_09.
3. Analytics aggregation over audit and learning events is a later phase.
4. Railway Hyperdrive and live Cloudflare bindings remain deployment-phase
   work.
5. Trusted auto-publication is deliberately limited to authenticated service
   principals; human session requests always receive review.

## Ready for next phase?

**Yes.** Every PHASE_09 deliverable, exact command, policy/concurrency
stop-condition, and screenshot requirement has current passing evidence. No
PHASE_10 work was started.

## Blockers

None.
