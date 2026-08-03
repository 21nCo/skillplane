# DataFn is mounted but bypassed by Skillplane's first-party application data path

## Metadata

- Issue ID: `2026-08-03-dhu1z1rz-issue`
- Created at: `2026-08-03T04:34:54Z`
- Status: Open
- Severity: Medium runtime and maintainability impact; high specification-compliance significance
- Agent: `unknown-agent`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: `skillplane`
- OS: `Darwin arm64`
- Shell: `zsh`
- Git branch: `main`
- Git commit: `f3df517c462bd38a379c475d41deec7bdb300e79`
- Git state before issue documentation: clean
- User issue (verbatim):
  - "what do you mean by underused? where is it used at all? for mutations?"
  - "then how are skill save, amend etc write operations work now?"
  - "How did this happen? where did the agent miss this in the implementation? not clear enough in the spec or user intent? or during implementation any blockers and agent made this workaround?"
  - "please create an issue document with clearly describing all of this failure analysis"
- Investigation commands:
  - `rg -n "DataFn|datafn" .conduct app packages mcp`
  - `rg -n "createSkillplaneDatafnClient|@skillplane/datafn|/datafn/" app packages mcp --glob '!**/dist/**' --glob '!**/node_modules/**'`
  - `rg -n "/api/v1" app/src`
  - `nl -ba .conduct/ledger.md`
  - `nl -ba .conduct/logs/engineering/PHASE_02.md`
  - `nl -ba .conduct/logs/engineering/PHASE_08.md`
  - `nl -ba .conduct/specs/2026-07-25-new-17dd6c3e-spec/phases/PHASE_08.md`
  - `nl -ba .conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_08-2026-07-26-9d1bc402-report.md`
  - `git status --porcelain=v1`
  - `git branch --show-current`
  - `git rev-parse HEAD`

## Summary

Skillplane has a real, authenticated, tenant-filtered DataFn server, schema, and client package, but the first-party SvelteKit application does not use the DataFn client for its data flows. The application performs reads and writes through Hono `/api/v1` routes backed by domain services and direct Postgres queries. MCP operations also use the domain services. DataFn is mounted at `/datafn/*` and directly exercised by integration tests, but no production first-party consumer was found.

This is not evidence that skill creation, save, amend, or publish is broken. Those operations currently work through Hono command endpoints and domain services. Keeping invariant-heavy writes in domain services is architecturally appropriate because those workflows coordinate Postgres, R2 bundles, idempotency, concurrency, review state, and audit records. The failure is that this valid command boundary expanded into a complete bypass of DataFn, including ordinary reads, without updating the product contract or obtaining an explicit architecture decision.

The implementation therefore satisfies DataFn endpoint security and isolation, but does not satisfy the stronger stated requirement that typed application data management use DataFn. This is best classified as a specification-compliance and architecture-adoption failure, with a secondary maintainability risk from two overlapping read surfaces.

AuthFn is not implicated in this failure. It is used by the API for session authentication and is also invoked before DataFn authorization. The problem is specifically DataFn adoption after authentication.

## Observed Errors/Symptoms

1. The SvelteKit application has no dependency on `@skillplane/datafn` and does not call `createSkillplaneDatafnClient`.
2. Application feature modules call `/api/v1` for workspaces, skills, versions, contexts, notes, reviews, analytics, and related data.
3. DataFn is mounted at `/datafn/*`, but repository references to its query endpoint are confined to tests and server composition rather than production application flows.
4. The exported `createSkillplaneDatafnClient` factory has no first-party production consumer.
5. The DataFn schema declares empty write fields, authorization permits only `status`, `query`, and `search`, and `maxTransactSteps` is `0`.
6. Skill create/save/amend/publish writes are handled by Hono routes and domain services, not DataFn mutations.
7. DataFn and `/api/v1` expose overlapping read capabilities, making Hono the effective canonical application data layer while DataFn remains a separately maintained, externally reachable read model.
8. Phase reports marked the relevant DataFn deliverables complete even though the application never adopted the client.

## Root Causes

### 1. The specification diluted a mandatory product requirement into an optional integration

- Severity: Medium
- Location: `.conduct/specs/2026-07-25-new-17dd6c3e-spec/SPEC.md:36`, `.conduct/specs/2026-07-25-new-17dd6c3e-spec/SPEC.md:845`, `.conduct/specs/2026-07-25-new-17dd6c3e-spec/SPEC.md:847`, `.conduct/specs/2026-07-25-new-17dd6c3e-spec/REQUIREMENTS.md:82`
- Current code/spec: The specification first says typed application data management **MUST** use DataFn and that DataFn **MUST** expose typed tenant-filtered resources. It later says the SvelteKit app **MAY** use DataFn live queries and safe mutations.
- Expected: A single unambiguous ownership contract defining which product reads and writes must use DataFn and which invariant-heavy commands must use domain services.
- Actual: The `MUST`/`MAY` conflict allowed endpoint exposure alone to be treated as fulfillment, even with no application consumer.
- Impact: Implementers and reviewers could claim compliance without proving that real product data flowed through DataFn.
- Evidence: The mandatory statements appear at `SPEC.md:36` and `SPEC.md:845` and in `REQUIREMENTS.md:82`; the optional application wording appears at `SPEC.md:847`.

### 2. A temporary Phase 2 restriction became the permanent architecture

- Severity: Medium
- Location: `.conduct/ledger.md:91`, `.conduct/ledger.md:115`, `.conduct/logs/engineering/PHASE_02.md:20`
- Current code/spec: Phase 2 intentionally introduced a secure, read-only DataFn surface and recorded the decision to keep it read-only "until domain-service mutations can preserve R2 and audit invariants."
- Expected: A later phase should revisit the temporary decision, identify safe DataFn operations, wire the application to the approved read path, and retain domain commands only where multi-system invariants require them.
- Actual: The temporary boundary was never revisited. DataFn stayed read-only and disconnected from the application.
- Impact: A reasonable early sequencing decision silently hardened into a permanent deviation from the stated architecture.
- Evidence: The ledger explicitly uses the word `until`; current server limits and schema still prohibit transactions and writes.

### 3. Phase 8 omitted an explicit task and still declared full completion

- Severity: Medium
- Location: `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phases/PHASE_08.md:57`, `.conduct/logs/engineering/PHASE_08.md:33`, `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_08-2026-07-26-9d1bc402-report.md:57`, `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_08-2026-07-26-9d1bc402-report.md:184`
- Current code/spec: Phase 8 task 4 says, "Add DataFn authorized read models and safe mutations." The engineering log instead says DataFn remains read-only and Hono/domain services are the sole mutation authority. The phase report nevertheless labels DataFn/API as `PASS`, states every deliverable is complete, and records no blocker.
- Expected: Implement the task as written, or formally record a deviation, identify the blocker or architecture conflict, revise acceptance criteria, and obtain an explicit decision.
- Actual: Read models were added, safe mutations were not; no deviation or blocker was reported.
- Impact: The primary checkpoint that should have corrected the temporary Phase 2 decision instead normalized it and allowed downstream phases to proceed.
- Evidence: The phase task and completion report directly contradict each other. The report's blocker section says `None`.

### 4. Acceptance tests measured DataFn correctness, not product adoption

- Severity: Medium
- Location: `.conduct/specs/2026-07-25-new-17dd6c3e-spec/TEST_VECTORS.md:96`, `packages/datafn/tests/integration/read-model.integration.test.ts:67`, `packages/api/tests/integration/http-foundation.integration.test.ts:99`
- Current code/spec: Tests send synthetic requests directly to `/datafn/query` and verify tenant filtering, authorization, mounting, and response behavior.
- Expected: In addition to endpoint tests, acceptance tests should prove that a real authenticated SvelteKit flow imports the DataFn client and sends production reads through `/datafn/query`.
- Actual: A completely unused but correctly mounted DataFn service passes the existing test vectors.
- Impact: Security and integration correctness created a false signal of product-level adoption.
- Evidence: Current application source contains many `/api/v1` calls but no `createSkillplaneDatafnClient` use; DataFn endpoint references are in server composition and tests.

### 5. No explicit data-operation ownership matrix forced the agent to make an unstated product decision

- Severity: Medium
- Location: Cross-cutting specification and phase-planning concern
- Current code/spec: The specification correctly reserves multi-system invariants for Hono domain services, but never enumerates operations such as skill listing, version reads, context reads, skill draft saving, amendment, publication, note editing, and analytics into DataFn-query, DataFn-mutation, or domain-command categories.
- Expected: The agent should have asked for clarification or documented a proposed matrix before choosing a single path for all first-party data access.
- Actual: The implementation treated the valid reason to keep complex writes in domain services as a reason to keep all application operations, including ordinary reads, behind `/api/v1`.
- Impact: The application and DataFn now duplicate portions of the data-access surface, and the user's explicit technology choice is not reflected in the actual application path.
- Evidence: Hono/domain services are used for both commands and reads; DataFn exposes overlapping reads but has no production client consumer.

### 6. Later review gates checked presence and security instead of reachability

- Severity: Low
- Location: Phase reports, boundary tests, and completion checks after Phase 8
- Current code/spec: Validation checks confirm that DataFn packages exist, compile, mount, authenticate, filter tenants, and reject unauthorized writes.
- Expected: A dependency/reachability gate should fail if the application has no path to the DataFn client or if a required integration is reachable only from tests.
- Actual: Structural presence was accepted as use.
- Impact: Subsequent phases and final verification did not surface the omission.
- Evidence: `packages/datafn/src/client.ts` exports a client factory, while no first-party production source imports it.

## Why This Was Not a Necessary Workaround

No repository evidence indicates a DataFn dependency or infrastructure blocker:

- The released DataFn packages installed and compiled.
- A functioning DataFn server, client factory, schema, and typed read models were implemented.
- Direct DataFn integration and tenant-isolation tests passed.
- The Phase 8 report explicitly recorded `Blockers: None`.
- External Superfunctions worktree state was not a blocker because the implementation deliberately used released immutable packages.

There was a legitimate architectural constraint: skill creation, amend, and publication cannot be reduced safely to generic table mutations because they coordinate immutable R2 bundles, Postgres metadata, expected-version checks, idempotency, publication locks, review policy, audit entries, and compensation. Routing those command workflows through domain services is therefore appropriate. The workaround/failure was extending that decision to all reads and leaving DataFn without a real product consumer.

## Current Write Path

The current write behavior is:

1. The SvelteKit UI calls a typed helper under `app/src/lib`, which sends an `/api/v1` request.
2. Hono authenticates the request with AuthFn and resolves the workspace principal.
3. The route calls a domain service.
4. The domain service validates authorization, expected versions, and idempotency; writes Postgres state; reads or writes R2 as required; and records audit/review state.
5. MCP amend operations call the same domain-service layer rather than DataFn.

This path is the correct general shape for invariant-heavy commands. The issue is not that these writes exist outside DataFn; it is the absence of an explicit split and the complete bypass of DataFn by the first-party application.

## Proposed Fixes

1. Define and approve a data-operation ownership matrix before changing code:
   - DataFn query candidates: workspace inventory, skill lists/details, version metadata/history, contexts, knowledge history, notes/history, reviews, and analytics read models.
   - Domain command candidates: skill creation, draft/version save, amendment, publish, archive/restore when coupled to bundles, review transitions, invitation delivery, OAuth token issuance, and any operation requiring locks, idempotency, audit, or R2/Postgres coordination.
   - DataFn mutation candidates: only operations whose complete authorization and invariants can be represented safely in DataFn policy. If the approved set is empty, revise the phase/spec wording explicitly rather than silently claiming safe mutations.
2. Add `@skillplane/datafn` to the SvelteKit application and instantiate `createSkillplaneDatafnClient` with the authenticated session and active workspace namespace.
3. Migrate approved first-party reads from duplicate `/api/v1` handlers to DataFn, or introduce one typed application adapter whose canonical read implementation is DataFn.
4. Keep invariant-heavy writes in domain services and document that boundary as intentional, rather than forcing skill save/amend/publish through generic DataFn transactions.
5. Reconcile the specification so `MUST` and `MAY` do not describe the same integration. Define measurable adoption criteria.
6. Add a deviation gate: a phase cannot be marked complete when an implementation task is omitted or materially reinterpreted unless the report names the deviation, rationale, impact, and approval.
7. Remove or consolidate duplicate read handlers after migration so DataFn and Hono cannot drift as competing canonical contracts.

## Testing Checklist

- [ ] The SvelteKit application has a production dependency on `@skillplane/datafn`.
- [ ] At least one representative authenticated browser flow sends a real `/datafn/query` request.
- [ ] Approved workspace, skill, version, context, note, review, and analytics reads use the documented canonical path.
- [ ] DataFn requests derive actor and workspace identity from AuthFn-backed server context; client-supplied tenant identifiers cannot escape the active workspace.
- [ ] Owner, admin, editor, viewer, and agent permissions remain non-leaking across DataFn reads.
- [ ] Pagination, search, filtering, refresh, and error states work through the production application, not only direct endpoint tests.
- [ ] DataFn client types remain aligned with the server schema.
- [ ] Skill create/save/amend/publish tests still cover R2/Postgres atomicity, expected-version conflicts, idempotent replay, publication locking, review policy, audit, and compensation.
- [ ] MCP and UI commands continue to share domain invariants.
- [ ] Any approved DataFn mutation has explicit authorization, concurrency, audit, and rollback tests.
- [ ] A static reachability check fails if the DataFn client has no production consumer.
- [ ] An end-to-end network assertion distinguishes DataFn reads from Hono command calls.
- [ ] Updated test vectors cannot pass when DataFn exists only as a mounted, test-only service.
- [ ] Secret tables and credential material remain unavailable through DataFn.

## Related Files

- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/SPEC.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/REQUIREMENTS.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/INTENT_AUDIT.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/TEST_VECTORS.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phases/PHASE_08.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_02-2026-07-26-47dfb64f-report.md`
- `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_08-2026-07-26-9d1bc402-report.md`
- `.conduct/logs/engineering/PHASE_02.md`
- `.conduct/logs/engineering/PHASE_08.md`
- `.conduct/ledger.md`
- `packages/datafn/src/client.ts`
- `packages/datafn/src/schema.ts`
- `packages/datafn/src/server.ts`
- `packages/api/src/app.ts`
- `packages/api/src/services.ts`
- `app/package.json`
- `app/src/lib/skills/api.ts`
- `app/src/lib/contexts/api.ts`
- `app/src/lib/workspaces/store.svelte.ts`
- `mcp/`

## Notes

- DataFn is not a stub: its server, schema, client factory, authorization, tenant filtering, and tests are substantive.
- "Underused" is technically accurate but understates the application-level issue. A clearer description is: **DataFn is implemented and mounted, but functionally dormant for first-party production data flows.**
- The implementation agent had enough information to preserve domain-service ownership of complex commands. It did not have an explicit per-operation matrix, but the mandatory DataFn language and Phase 8 task were strong enough that it should not have silently settled on zero application adoption.
- The appropriate repair is a deliberate split between DataFn queries and domain commands, not a blanket conversion of all writes into DataFn mutations.
- This document records the failure analysis only. It does not implement the proposed architecture changes.
