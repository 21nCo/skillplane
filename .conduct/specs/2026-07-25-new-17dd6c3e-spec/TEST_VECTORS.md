# Test vectors

## Canonical fixtures

- Clock: `2026-07-25T06:00:00Z`.
- Workspace A: `ws_a`, slug `acme`, owner `user_owner`, editor `user_editor`, viewer `user_viewer`.
- Workspace B: `ws_b`, owner `user_other`.
- Service principal: `sp_reviewbot`, role `editor`, scopes `skills:read skills:amend contexts:read contexts:write`.
- Skill: `skill_pr_review`, workspace `ws_a`, slug `pr-review`, current version `sv_7`, semantic version `1.2.3`, digest `sha256:skill7`.
- Context: `ctx_btnextjs`, skill `skill_pr_review`, current knowledge revision `ck_3`.
- Note: `note_threads`, current revision `cn_2`.
- OAuth resource: `https://mcp.skillplane.dev/mcp`.
- Caller fixture:

```json
{
  "agentId": "agent_codex_1",
  "agentName": "Codex",
  "modelProvider": "OpenAI",
  "modelName": "gpt-5",
  "modelVersion": "2026-07-01",
  "clientName": "Codex Desktop",
  "clientVersion": "1.0.0",
  "runId": "run_1",
  "sessionId": "session_1",
  "conversationId": "conversation_1"
}
```

Hashes and tokens below are illustrative deterministic fixture values, not production secrets.

## Project and architecture

### TV-PROJ-001-P

- Description: required workspaces build from the root.
- Input: `pnpm install --frozen-lockfile && pnpm turbo run build --filter=./app --filter=./landing --filter=./mcp`
- Expected output: exit `0`; three deployable artifacts; workspace graph resolves shared packages.

### TV-PROJ-001-N

- Description: duplicated non-workspace domain import is rejected.
- Input: boundary check finds `app/src/lib/domain/skill-version.ts` duplicating `packages/domain/src/skill-version.ts`.
- Expected output: exit non-zero with `WORKSPACE_BOUNDARY_VIOLATION`.

### TV-PROJ-002-P

- Description: production adapter validation accepts all real bindings.
- Input: production config containing Postgres/Hyperdrive, R2, Email, Turnstile, and secrets.
- Expected output: `{ "ok": true }`; no fake provider is imported in the production graph.

### TV-PROJ-002-N

- Description: production startup rejects a capture email provider.
- Input: `EMAIL_PROVIDER=capture` with `NODE_ENV=production`.
- Expected output: startup failure `PRODUCTION_ADAPTER_INVALID`.

### TV-PROJ-003-P

- Description: phase evidence is append-only and complete.
- Input: phase report, ledger entry, engineering log, command output, and UI screenshots for a UI phase.
- Expected output: conduct verification exits `0`.

### TV-PROJ-003-N

- Description: rewritten log history is rejected.
- Input: Git diff deletes an existing `.conduct/logs.csv` row.
- Expected output: conduct verification fails with `CONDUCT_APPEND_ONLY_VIOLATION`.

### TV-PROJ-004-P

- Description: non-overlapping Superfunctions adapter change is logged.
- Input: pre-edit log names a clean new adapter file, export file status, tests, and later records actual diff and results.
- Expected output: change-log verifier exits `0`.

### TV-PROJ-004-N

- Description: overlapping dirty external edit blocks execution.
- Input: target export file is modified before Skillplane work and no user authorization is recorded.
- Expected output: phase stops with `EXTERNAL_WORKTREE_OVERLAP`.

## Data and backend

### TV-DATA-001-P

- Description: identical migrations run locally and on a disposable Postgres database.
- Input: `pnpm db:migrate && pnpm db:verify`.
- Expected output: migration version and constraints match; exit `0`.

### TV-DATA-001-N

- Description: in-memory database is prohibited in production.
- Input: `DATABASE_ADAPTER=memory` with production environment.
- Expected output: startup failure `DATABASE_ADAPTER_INVALID`.

### TV-DATA-002-P

- Description: editor queries authorized skill resources through DataFn.
- Input: DataFn query for `skill_pr_review` authenticated as `user_editor`.
- Expected output: one skill record with workspace `ws_a`.

### TV-DATA-002-N

- Description: another workspace cannot query a private skill by ID.
- Input: same DataFn query authenticated as `user_other`.
- Expected output: empty result or `WORKSPACE_FORBIDDEN`; no title, digest, or existence metadata.

### TV-DATA-003-P

- Description: Hono composition mounts required routers.
- Input: `GET /auth/session`, `POST /datafn/query`, and `GET /api/v1/workspaces` with valid test auth.
- Expected output: each route resolves through the canonical Hono app and includes one request ID.

### TV-DATA-003-N

- Description: duplicate SvelteKit business route is rejected.
- Input: route inventory finds direct skill mutation outside `packages/api`.
- Expected output: boundary test fails `DUPLICATE_API_COMPOSITION`.

### TV-DATA-004-P

- Description: canonical bundle is written once by digest.
- Input: 2,048-byte bundle digest `sha256:abc` uploaded twice for the same skill.
- Expected output: one R2 object; both calls reference identical key and bytes.

### TV-DATA-004-N

- Description: digest collision overwrite is rejected.
- Input: existing key `sha256:abc` with different proposed bytes.
- Expected output: `R2_WRITE_FAILED`; original object unchanged.

## Authentication and authorization

### TV-AUTH-001-P

- Description: valid email OTP creates a session.
- Input: send OTP for `alice@example.test`, then verify fixture code `123456` within TTL.
- Expected output: `200`, AuthFn session for `user_owner`, secure cookies, no OTP in response.

### TV-AUTH-001-N

- Description: invalid OTP does not disclose account existence.
- Input: verify `000000` for known and unknown fixture emails.
- Expected output: same safe envelope and status class; no session created.

### TV-AUTH-002-P

- Description: SendFn delivers through Cloudflare binding.
- Input: adapter binding resolves `{ "messageId": "cf_msg_1" }` for an OTP email.
- Expected output: SendFn success with provider `cloudflare-email`, message ID `cf_msg_1`, and timestamp.

### TV-AUTH-002-N

- Description: permanent provider rejection is surfaced safely.
- Input: binding rejects sender domain with fixture provider code.
- Expected output: `EMAIL_DELIVERY_FAILED`, retryable `false`; recipient and body absent from logs.

### TV-AUTH-003-P

- Description: valid CSRF and Turnstile permit a risky OTP send.
- Input: cookie session or anonymous risk request with matching CSRF where applicable and valid Turnstile token.
- Expected output: generic send response and one rate-limit increment.

### TV-AUTH-003-N

- Description: invalid CSRF or Turnstile is rejected.
- Input: state-changing cookie request with mismatched CSRF or risk-triggered OTP send without Turnstile.
- Expected output: `AUTH_CSRF_INVALID` or generic `AUTH_RATE_LIMITED`; no email sent.

### TV-AUTH-004-P

- Description: role matrix permits editor amendment and admin approval.
- Input: `user_editor` creates candidate; `user_owner` approves.
- Expected output: candidate then published version; two attributable audit events.

### TV-AUTH-004-N

- Description: viewer cannot amend.
- Input: `user_viewer` calls amendment endpoint for `skill_pr_review`.
- Expected output: `403 WORKSPACE_FORBIDDEN`; no R2 or version write.

### TV-AUTH-005-P

- Description: MCP client completes authorization-code flow.
- Input: registered HTTPS client, valid AuthFn session, consent, resource, scope, state, and S256 challenge.
- Expected output: one-time code then audience-bound access and refresh tokens with metadata-discoverable endpoints.

### TV-AUTH-005-N

- Description: unauthenticated authorization does not silently grant.
- Input: `/auth/oauth/authorize` without AuthFn session.
- Expected output: safe sign-in redirect preserving signed authorization request; no code or consent created.

### TV-AUTH-006-P

- Description: correct verifier redeems a code once and refresh rotates.
- Input: valid code, verifier, redirect, client, and canonical resource; then one refresh.
- Expected output: access token TTL at most 3,600 seconds; old refresh invalidated; new refresh issued.

### TV-AUTH-006-N

- Description: OAuth attack variants fail.
- Input: wrong verifier, wildcard redirect, wrong resource, reused code, or reused rotated refresh token.
- Expected output: OAuth `invalid_grant`/`invalid_request`; token family revoked on refresh reuse; security event stored.

### TV-AUTH-007-P

- Description: scoped service principal retrieves and amends.
- Input: `sp_reviewbot` credential with fixture scopes and caller declaration.
- Expected output: read and candidate creation succeed within `ws_a`.

### TV-AUTH-007-N

- Description: revoked or over-scoped service credential fails.
- Input: revoked credential or request for `audit:read` absent from grant.
- Expected output: `AUTH_INVALID` or `AUTH_SCOPE_REQUIRED`; no protected data.

### TV-AUTH-008-P

- Description: authenticated and declared identities are stored separately.
- Input: OAuth token for `user_owner` plus caller fixture.
- Expected output: audit principal `user_owner`; caller model `gpt-5`; trust labels `authenticated` and `declared`.

### TV-AUTH-008-N

- Description: supplied user metadata cannot impersonate another user.
- Input: caller payload additionally contains `"userId":"user_other"`.
- Expected output: schema rejects unknown field or ignores it; principal remains `user_owner`.

## Tenancy

### TV-TEN-001-P

- Description: first login creates exactly one personal workspace.
- Input: two concurrent first-session callbacks for new user `user_new`.
- Expected output: one personal workspace and one owner membership.

### TV-TEN-001-N

- Description: final owner cannot be removed.
- Input: `user_owner` attempts to remove their only owner membership.
- Expected output: `WORKSPACE_FORBIDDEN` with safe reason; membership unchanged.

### TV-TEN-002-P

- Description: invitation is accepted once.
- Input: unexpired invitation for normalized fixture email and authenticated matching user.
- Expected output: requested role membership created; invitation marked accepted.

### TV-TEN-002-N

- Description: expired, revoked, reused, or mismatched invitation fails.
- Input: each invalid invitation condition.
- Expected output: stable invitation error; no duplicate membership.

### TV-TEN-003-P

- Description: public and member visibility behave consistently.
- Input: anonymous public skill read and member workspace skill read.
- Expected output: published public content for anonymous; workspace content for member.

### TV-TEN-003-N

- Description: anonymous candidate/context read is denied.
- Input: public skill candidate version or context ID without credential.
- Expected output: `AUTH_REQUIRED` or non-leaking `SKILL_VERSION_NOT_FOUND`.

## Skill lifecycle

### TV-SKL-001-P

- Description: first skill creation publishes `1.0.0`.
- Input: valid metadata and deterministic bundle in `ws_a`.
- Expected output: skill, revision 1, semantic version `1.0.0`, R2 object, release pointer, audit event.

### TV-SKL-001-N

- Description: duplicate slug or failed R2 write creates no partial skill.
- Input: slug `pr-review` already exists or R2 binding fails.
- Expected output: `SKILL_SLUG_CONFLICT` or `R2_WRITE_FAILED`; no new visible database rows.

### TV-SKL-002-P

- Description: valid portable bundle is accepted.
- Input: root `SKILL.md`, `skill.json`, `references/checklist.md`, `scripts/check.sh`.
- Expected output: manifest contains four normalized paths and SHA-256 values.

### TV-SKL-002-N

- Description: missing root instruction file is rejected.
- Input: bundle containing only `skill.json`.
- Expected output: `SKILL_BUNDLE_INVALID`; no R2 commit.

### TV-SKL-003-P

- Description: different archive ordering canonicalizes identically.
- Input: two archives with same files in different order and timestamps.
- Expected output: identical canonical bytes and digest.

### TV-SKL-003-N

- Description: unsafe archive is rejected.
- Input: entry `../secret`, symlink, case-fold duplicate, or expansion beyond 25 MiB.
- Expected output: `SKILL_PATH_INVALID` or `SKILL_BUNDLE_TOO_LARGE`; extraction stops.

### TV-SKL-004-P

- Description: update creates immutable next revision.
- Input: base revision 7 and valid replacement.
- Expected output: revision 8 exists; revision 7 bytes and metadata unchanged.

### TV-SKL-004-N

- Description: update-in-place is impossible.
- Input: direct attempt to modify published `sv_7` content or R2 key.
- Expected output: database/storage policy rejection; original digest unchanged.

### TV-SKL-005-P

- Description: patch candidate publishes against current `1.2.3`.
- Input: approved revision 8 proposed bump `patch`.
- Expected output: revision 8 semantic version `1.2.4`; release pointer updated atomically.

### TV-SKL-005-N

- Description: concurrent publish detects conflict.
- Input: revisions 8 and 9 both approve from current `1.2.3`.
- Expected output: one becomes `1.2.4`; the other returns `SKILL_PUBLISH_CONFLICT` and remains candidate.

### TV-SKL-006-P

- Description: valid amendment is replay-safe.
- Input: base `sv_7`, matching file digest, one replace operation, learning metadata, idempotency key `amend-1`.
- Expected output: one candidate revision; identical replay returns its ID.

### TV-SKL-006-N

- Description: stale digest or changed idempotent payload fails.
- Input: wrong expected SHA or reuse `amend-1` with different content.
- Expected output: `SKILL_VERSION_CONFLICT` or `IDEMPOTENCY_KEY_REUSED`; no extra revision.

### TV-SKL-007-P

- Description: structured learning metadata persists and renders.
- Input: complete learning fixture with evidence, validation, context, tags, and bounded extra JSON.
- Expected output: stored metadata equals normalized input and is present beside diff.

### TV-SKL-007-N

- Description: missing rationale or excessive metadata is rejected.
- Input: empty rationale or depth 9 `extra`.
- Expected output: `LEARNING_METADATA_INVALID`; no candidate.

### TV-SKL-008-P

- Description: review-required and trusted-auto policies diverge correctly.
- Input: normal editor credential then trusted service credential within patch/daily policy.
- Expected output: first remains candidate; second records policy decision and publishes after validation.

### TV-SKL-008-N

- Description: auto-publish outside policy is denied.
- Input: trusted credential proposes major bump or exceeds daily limit.
- Expected output: candidate remains review-required or `AMENDMENT_POLICY_DENIED`; no silent publish.

### TV-SKL-009-P

- Description: archive and restore preserve history.
- Input: archive then restore `skill_pr_review`.
- Expected output: default search hides then shows skill; current version remains `sv_7`.

### TV-SKL-009-N

- Description: archived skill cannot receive default amendment.
- Input: `skill_amend` without explicit archived-skill override.
- Expected output: `AMENDMENT_POLICY_DENIED`; no revision.

### TV-SKL-010-P

- Description: authorized full-text search is deterministic.
- Input: query `pull request review`, limit 20, user `user_editor`.
- Expected output: `skill_pr_review`; repeat produces same order and cursor.

### TV-SKL-010-N

- Description: cursor and tenant leakage are rejected.
- Input: reuse cursor with changed tags or search as `user_other`.
- Expected output: `CURSOR_FILTER_MISMATCH` or result excluding `skill_pr_review`.

## Contexts and notes

### TV-CTX-001-P

- Description: editor creates a repository context.
- Input: `{ "skillId":"skill_pr_review","slug":"btnextjs","name":"btnextjs","type":"repository","externalReference":"repo:btnextjs" }`.
- Expected output: context `ctx_btnextjs` under `skill_pr_review`.

### TV-CTX-001-N

- Description: duplicate or cross-workspace context fails.
- Input: duplicate slug `btnextjs` under the same skill or skill ID from `ws_b`.
- Expected output: `CONTEXT_SLUG_CONFLICT` or `WORKSPACE_FORBIDDEN`.

### TV-CTX-002-P

- Description: context knowledge update creates immutable revision.
- Input: expected revision `ck_3`, body `Inspect live review threads before local diff conclusions.`
- Expected output: revision `ck_4`; `ck_3` unchanged.

### TV-CTX-002-N

- Description: stale context knowledge update conflicts.
- Input: expected revision `ck_2` while current is `ck_3`.
- Expected output: `CONTEXT_REVISION_CONFLICT` with current revision reference.

### TV-CTX-003-P

- Description: note create, update, and archive preserve history.
- Input: create `Review thread API`, update from revision 1, then archive.
- Expected output: two immutable revisions; default list excludes archived note.

### TV-CTX-003-N

- Description: note update without base revision fails.
- Input: update `note_threads` with no expected revision.
- Expected output: `NOTE_REVISION_CONFLICT`; note unchanged.

### TV-CTX-004-P

- Description: retrieval combines exact skill and context revisions.
- Input: skill `sv_7`, context knowledge `ck_3`, include notes.
- Expected output: response names both digests and includes authorized active notes without creating writes.

### TV-CTX-004-N

- Description: context from a different skill is rejected.
- Input: `skill_pr_review` with context belonging to another skill.
- Expected output: `CONTEXT_NOT_FOUND`; no context metadata leaked.

### TV-CTX-005-P

- Description: replayed note mutation returns original revision.
- Input: same note body, expected revision, and idempotency key twice.
- Expected output: one revision and identical response reference.

### TV-CTX-005-N

- Description: concurrent note writes do not last-write-win.
- Input: two different updates both based on `cn_2`.
- Expected output: one creates `cn_3`; one returns `NOTE_REVISION_CONFLICT`.

## MCP

### TV-MCP-001-P

- Description: authorized Streamable HTTP session initializes.
- Input: `POST /mcp` initialize request with valid audience-bound token.
- Expected output: MCP protocol response, supported server version, and tool list.

### TV-MCP-001-N

- Description: missing or under-scoped token receives standards challenge.
- Input: `POST /mcp` without token, then with token lacking requested scope.
- Expected output: `401` with protected-resource metadata, then `403` with required scope.

### TV-MCP-002-P

- Description: complete caller declaration passes schema.
- Input: `skill_retrieve` with the canonical caller fixture.
- Expected output: tool executes and audit contains every declared field.

### TV-MCP-002-N

- Description: missing model version fails before domain access.
- Input: caller fixture without `modelVersion`.
- Expected output: MCP invalid-params result; no R2 read.

### TV-MCP-003-P

- Description: MCP search returns authorized current metadata.
- Input:

```json
{
  "query": "pull request review",
  "workspaceId": "ws_a",
  "visibility": ["private", "workspace", "public"],
  "tags": ["review"],
  "cursor": null,
  "limit": 20,
  "caller": "canonical-caller-fixture"
}
```

- Expected output: result for `skill_pr_review` with version `1.2.3`, digest `sha256:skill7`, and opaque cursor.

### TV-MCP-003-N

- Description: maximum limit and authorization are enforced.
- Input: limit `101` or workspace `ws_a` requested by `user_other`.
- Expected output: invalid params or authorized empty result; no total-count leak.

### TV-MCP-004-P

- Description: retrieve returns exact instructions and selected context.
- Input: current `skill_pr_review`, `ctx_btnextjs`, include notes, canonical caller.
- Expected output: `sv_7`, digest `sha256:skill7`, manifest, `SKILL.md`, `ck_3`, active notes, and audit request ID.

### TV-MCP-004-N

- Description: unsafe asset or R2 failure does not substitute content.
- Input: asset path `../secret` or simulated missing R2 object for `sv_7`.
- Expected output: `SKILL_PATH_INVALID` or `R2_READ_FAILED`; no other version returned.

### TV-MCP-005-P

- Description: editor lists published and candidate history.
- Input: `skill_versions_list` for `skill_pr_review`, states `published,candidate`.
- Expected output: authorized cursor page with immutable revision, semver, state, digest, and learning summary.

### TV-MCP-005-N

- Description: anonymous public caller cannot list candidates.
- Input: public credential requests state `candidate`.
- Expected output: `AUTH_SCOPE_REQUIRED` or candidates omitted with no count leak.

### TV-MCP-006-P

- Description: scoped agent creates a candidate amendment.
- Input: canonical `skill_amend` example from `SPEC.md` with valid credential.
- Expected output: `{ "state":"candidate", "baseVersionId":"sv_7" }`, one revision, one audit event.

### TV-MCP-006-N

- Description: unsafe or unauthorized amendment fails.
- Input: missing `skills:amend`, path `../../x`, stale base, or missing learning evidence.
- Expected output: stable scope/path/version/metadata error; no R2 or version commit.

### TV-MCP-007-P

- Description: context tools read and update a shared note.
- Input: `context_get` then `context_note_upsert` from `cn_2` with write scope.
- Expected output: selected context plus new immutable note revision `cn_3`.

### TV-MCP-007-N

- Description: read-only token cannot update context.
- Input: `context_note_upsert` with only `contexts:read`.
- Expected output: `AUTH_SCOPE_REQUIRED`; note remains at `cn_2`.

### TV-MCP-008-P

- Description: MCP conflict is machine-readable and retry-safe.
- Input: duplicate exact amendment idempotency request.
- Expected output: original success reference, not an error or duplicate.

### TV-MCP-008-N

- Description: changed idempotent request and cursor filters fail safely.
- Input: same idempotency key with different digest, or cursor reused with different filters.
- Expected output: `IDEMPOTENCY_KEY_REUSED` or `CURSOR_FILTER_MISMATCH` in `isError: true`; no stack.

## Audit and analytics

### TV-AUD-001-P

- Description: private retrieval writes audit before response.
- Input: authorized `skill_retrieve`.
- Expected output: response request ID matches durable audit event containing principal, credential, caller, version, context, outcome, and latency.

### TV-AUD-001-N

- Description: audit persistence failure fails closed.
- Input: force audit transaction failure before private R2 content response.
- Expected output: safe `INTERNAL_ERROR` or `DATABASE_UNAVAILABLE`; content body not sent.

### TV-AUD-002-P

- Description: retention expires only detailed reads.
- Input: run retention at fixed clock with a 91-day retrieval event and 400-day amendment event.
- Expected output: retrieval detail deleted; amendment event and daily aggregate retained.

### TV-AUD-002-N

- Description: retention cannot delete permanent security events.
- Input: candidate deletion set includes refresh-reuse event.
- Expected output: transaction rejects or excludes permanent event; safety alert logged.

### TV-AUD-003-P

- Description: analytics rollup is idempotent.
- Input: process the same ten retrievals and two amendments for one UTC day twice.
- Expected output: aggregate remains ten and two, not twenty and four.

### TV-AUD-003-N

- Description: content and prompt fields are rejected from analytics.
- Input: event payload includes `prompt` or `skillBody`.
- Expected output: schema validation/redaction removes field and records safe diagnostic.

### TV-AUD-004-P

- Description: admin filters and exports authorized audit.
- Input: owner filters by skill, context, agent, model, outcome, and date; exports current page.
- Expected output: redacted records matching filters and workspace only.

### TV-AUD-004-N

- Description: viewer cannot access detailed audit.
- Input: `user_viewer` requests audit endpoint.
- Expected output: `403 WORKSPACE_FORBIDDEN`; no event count or dimensions.

## User interface

### TV-UI-001-P

- Description: design-system token and theme contract passes.
- Input: render primitives in light/dark, compact/comfortable, focus/reduced-motion modes.
- Expected output: visual snapshots and contrast checks pass; Phosphor icon sizing is consistent.

### TV-UI-001-N

- Description: raw feature color and unapproved icon import are rejected.
- Input: feature component uses literal color and non-Phosphor icon package.
- Expected output: lint/style-boundary failure.

### TV-UI-002-P

- Description: authenticated user completes core app workflow.
- Input: create workspace, skill, context, note, candidate, approve, inspect analytics, reload.
- Expected output: every state persists and matches backend records.

### TV-UI-002-N

- Description: unauthorized UI action cannot succeed through direct request.
- Input: viewer reveals or manually posts approval request.
- Expected output: control absent/disabled and server returns `403`; candidate unchanged.

### TV-UI-003-P

- Description: landing links and claims map to shipped routes.
- Input: crawl landing navigation, public skills, sign-in, sitemap, canonical URL, and social metadata.
- Expected output: all internal links `2xx`, metadata correct, claims present in feature inventory.

### TV-UI-003-N

- Description: unsupported billing or marketplace claim is rejected.
- Input: content check finds `pricing plan`, `buy skill`, or marketplace payout claim.
- Expected output: content contract test fails.

### TV-UI-004-P

- Description: critical workflows pass accessibility and viewport matrix.
- Input: keyboard-only and automated checks at 390x844, 768x1024, and 1440x900 in both themes.
- Expected output: no serious violations; all actions reachable; focus visible.

### TV-UI-004-N

- Description: unlabeled input or trapped dialog fails.
- Input: OTP field without accessible label or dialog that cannot close by keyboard.
- Expected output: automated/manual accessibility gate fails.

### TV-UI-005-P

- Description: all state variants are observable.
- Input: fixture each page into loading, empty, success, validation, forbidden, server error, retry, and destructive confirmation.
- Expected output: stable screenshot and correct action for every state.

### TV-UI-005-N

- Description: silent failure or inert action fails.
- Input: backend returns `R2_WRITE_FAILED` during publish.
- Expected output: error state explains failure and retry; release pointer unchanged; no success toast.

## Operations

### TV-OPS-001-P

- Description: local Postgres starts and becomes healthy.
- Input: Docker available, port 5432 free, `pnpm db:up`.
- Expected output: named container and volume, `pg_isready` success, migrations proceed.

### TV-OPS-001-N

- Description: port conflict is explicit.
- Input: listener occupies configured port before `pnpm db:up`.
- Expected output: command exits non-zero naming `SKILLPLANE_POSTGRES_PORT`; no random port/container.

### TV-OPS-002-P

- Description: Worker uses Hyperdrive while migrations use direct Railway URL.
- Input: production Worker binding and separate migration environment.
- Expected output: request client receives Hyperdrive connection string; migration client receives direct URL.

### TV-OPS-002-N

- Description: missing Hyperdrive ID blocks production deploy.
- Input: production deployment without supplied ID.
- Expected output: predeploy exits non-zero before `wrangler deploy`; no placeholder config emitted.

### TV-OPS-003-P

- Description: production host trust boundaries are correct.
- Input: probe apex, app, and MCP domains after deployment.
- Expected output: TLS valid; landing/app/MCP content distinct; OAuth metadata resource exact.

### TV-OPS-003-N

- Description: preview token is rejected at production MCP.
- Input: access token audience names a preview resource.
- Expected output: `401 AUTH_INVALID`; no tool execution.

### TV-OPS-004-P

- Description: configuration schema accepts complete bindings.
- Input: valid local or production environment object.
- Expected output: typed config with redacted diagnostics.

### TV-OPS-004-N

- Description: secret leak and missing binding are blocked.
- Input: browser build containing database URL or production runtime without R2 binding.
- Expected output: bundle scan/startup fails with safe stable code.

### TV-OPS-005-P

- Description: safe cache policy and indexes meet targets.
- Input: load test public immutable skill and private current pointer; run query-plan checks.
- Expected output: immutable response cacheable by digest, private response `no-store`, required indexes used, latency target met.

### TV-OPS-005-N

- Description: cached authorization or stale pointer is rejected.
- Input: revoke membership or publish new version, then repeat prior request.
- Expected output: revoked access denied immediately and current pointer returns new version.

### TV-OPS-006-P

- Description: backup, restore, and orphan cleanup rehearsal succeeds.
- Input: backup fixture database and R2 inventory, restore to disposable environment, run cleanup.
- Expected output: all referenced bundles resolve; only fixture orphan deleted.

### TV-OPS-006-N

- Description: cleanup refuses referenced or uncertain objects.
- Input: object digest referenced by a version or database query unavailable.
- Expected output: object preserved; cleanup reports safe failure.

## Quality

### TV-QA-001-P

- Description: root deterministic suites pass.
- Input: `pnpm test:unit && pnpm test:integration`.
- Expected output: exit `0`; production bundle contains no test fixture imports.

### TV-QA-001-N

- Description: missing invariant coverage blocks phase.
- Input: mutation handler added without referenced positive, negative, boundary, and conflict tests.
- Expected output: requirements/test mapping gate fails.

### TV-QA-002-P

- Description: E2E persists critical workflow across reload.
- Input: Playwright creates and publishes a skill/context amendment, reloads, and reopens history.
- Expected output: immediate and post-reload assertions pass against real local services.

### TV-QA-002-N

- Description: toast-only write proof is insufficient.
- Input: E2E asserts only success toast and does not cross a persistence boundary.
- Expected output: E2E quality gate fails.

### TV-QA-003-P

- Description: release security matrix passes.
- Input: tenant, OAuth, archive, Markdown, CSRF, rate-limit, and redaction attack suite.
- Expected output: every attack denied/sanitized with no protected leakage.

### TV-QA-003-N

- Description: one exploitable security vector blocks release.
- Input: refresh token reuse still yields a token or archive traversal writes outside temp root.
- Expected output: release verification exits non-zero.

### TV-QA-004-P

- Description: phase completion has full evidence.
- Input: green commands, manual observations, screenshots where applicable, ledger link, and phase report.
- Expected output: tracker may advance to the next phase.

### TV-QA-004-N

- Description: incomplete verification cannot be marked complete.
- Input: phase report claims completion while one required command failed or screenshot is absent.
- Expected output: phase status remains incomplete and blocker is recorded.
