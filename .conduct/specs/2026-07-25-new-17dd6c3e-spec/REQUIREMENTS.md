# Requirements

## Table of contents

- Project and architecture: `PROJ-001`–`PROJ-004`, `DATA-001`–`DATA-004`
- Authentication and authorization: `AUTH-001`–`AUTH-008`
- Tenancy: `TEN-001`–`TEN-003`
- Skill lifecycle: `SKL-001`–`SKL-010`
- Contexts and notes: `CTX-001`–`CTX-005`
- MCP: `MCP-001`–`MCP-008`
- Audit and analytics: `AUD-001`–`AUD-004`
- User experience: `UI-001`–`UI-005`
- Operations: `OPS-001`–`OPS-006`
- Quality: `QA-001`–`QA-004`

---

## PROJ-001

- Priority: P0
- Statement: Skillplane MUST be a pnpm/Turborepo monorepo with production packages rooted at `app/`, `landing/`, `mcp/`, and `packages/`.
- Rationale: The requested surfaces require independent deployment with shared contracts and domain logic.
- Acceptance criteria:
  - Root workspace configuration includes all required roots.
  - `app/` and `landing/` are SvelteKit applications.
  - `mcp/` is a separately deployable Worker.
  - Shared code is consumed from workspace packages without source duplication.
- Test vectors: `TV-PROJ-001-P`, `TV-PROJ-001-N`
- Notes: Additional root directories for scripts and tests are allowed.

## PROJ-002

- Priority: P0
- Statement: Production code MUST contain no placeholder routes, fake production adapters, inert controls, scaffold-only screens, or sample-only persistence.
- Rationale: The user explicitly prohibited stubs and scaffolding-only delivery.
- Acceptance criteria:
  - Every rendered control has a backed action or is intentionally disabled with a real reason.
  - Production dependency injection rejects missing required services.
  - Fake bindings and fixtures exist only under test paths.
- Test vectors: `TV-PROJ-002-P`, `TV-PROJ-002-N`
- Notes: Loading skeletons and empty states are product states, not stubs.

## PROJ-003

- Priority: P0
- Statement: The project MUST maintain append-only implementation evidence under `.conduct` from the first substantial step.
- Rationale: The user requires a running ledger, engineering logs, decisions, observations, and screenshots.
- Acceptance criteria:
  - Ledger, decisions, engineering logs, observations, screenshots index, tracker, and spec logs exist.
  - Each phase appends evidence and a completion report.
  - Existing log rows and ledger entries are never rewritten.
- Test vectors: `TV-PROJ-003-P`, `TV-PROJ-003-N`
- Notes: Secrets and machine-specific paths are prohibited in committed evidence.

## PROJ-004

- Priority: P0
- Statement: Any Superfunctions edit MUST be narrowly scoped, preserve pre-existing changes, and receive a project-local log under `.conduct/logs/superfunctions/`.
- Rationale: Superfunctions changes must not become broad refactors or overwrite concurrent work.
- Acceptance criteria:
  - Pre-edit status and target paths are recorded.
  - Overlapping dirty changes cause a stop unless explicitly authorized.
  - Post-edit diff, tests, compatibility, and rollback are recorded.
- Test vectors: `TV-PROJ-004-P`, `TV-PROJ-004-N`
- Notes: Skillplane-local integration is preferred when a shared-package change is unnecessary.

## DATA-001

- Priority: P0
- Statement: Skillplane MUST use real Postgres locally and Railway Postgres in production.
- Rationale: Both development and production persistence must exercise the actual database semantics.
- Acceptance criteria:
  - Local Docker Postgres persists to a named volume and passes a health check.
  - Production connection origin is Railway.
  - The same migrations and constraints execute in both environments.
- Test vectors: `TV-DATA-001-P`, `TV-DATA-001-N`
- Notes: SQLite and in-memory production fallbacks are forbidden.

## DATA-002

- Priority: P0
- Statement: Skillplane MUST use DataFn for typed tenant-filtered application data access while reserving multi-system invariants for domain services.
- Rationale: DataFn is required, but R2 publication and OAuth workflows need stronger orchestration.
- Acceptance criteria:
  - DataFn schema covers workspaces, memberships, skills, versions, contexts, notes, reviews, and analytics reads.
  - Authenticated reads approved in the data-operation ownership matrix use DataFn as their first-party canonical path.
  - Every private resource query is tenant-filtered before results are returned.
  - R2 publication, OAuth tokens, and other cross-system transactions cannot be bypassed through generic mutations.
- Test vectors: `TV-DATA-002-P`, `TV-DATA-002-N`
- Notes: Secret token tables are never exposed as DataFn resources.

## DATA-003

- Priority: P0
- Statement: Shared backend HTTP composition MUST use Hono and mount AuthFn, DataFn, domain API, and observability through explicit adapters.
- Rationale: Hono is the requested backend and provides a Worker-compatible composition root.
- Acceptance criteria:
  - Hono exposes `/api/v1`, `/auth`, and `/datafn` from the app Worker.
  - MCP uses an independent Hono Worker and shared domain packages.
  - Middleware order for request IDs, security headers, auth, authorization, rate limits, and observability is tested.
- Test vectors: `TV-DATA-003-P`, `TV-DATA-003-N`
- Notes: SvelteKit server routes delegate to the canonical Hono application rather than reimplementing endpoints.

## DATA-004

- Priority: P0
- Statement: Immutable skill bundles MUST be stored in a private R2 bucket using content-addressed keys.
- Rationale: R2 is required for skill files and content addressing prevents accidental overwrite.
- Acceptance criteria:
  - Object key contains workspace, skill, and SHA-256 digest.
  - Different bytes cannot replace an existing digest key.
  - Database metadata contains key, digest, size, and manifest.
  - Access is mediated by authorized Workers.
- Test vectors: `TV-DATA-004-P`, `TV-DATA-004-N`
- Notes: Public R2 bucket access is forbidden.

## AUTH-001

- Priority: P0
- Statement: User authentication MUST use AuthFn email OTP with secure session issuance and generic anti-enumeration responses.
- Rationale: AuthFn and email OTP are explicit requirements.
- Acceptance criteria:
  - OTP send and verify use AuthFn routes and tables.
  - Successful verification creates an AuthFn session.
  - Unknown and known email send responses are externally indistinguishable.
  - OTP codes never appear in production responses or logs.
- Test vectors: `TV-AUTH-001-P`, `TV-AUTH-001-N`
- Notes: Password authentication is Undefined and therefore not required.

## AUTH-002

- Priority: P0
- Statement: AuthFn OTP delivery MUST use SendFn through a production Cloudflare Email Service adapter.
- Rationale: Email must flow through the requested reusable delivery abstraction.
- Acceptance criteria:
  - The adapter implements SendFn `EmailProvider`.
  - OTP delivery receives a provider message ID or a typed failure.
  - Production has no console, capture, or no-op fallback.
  - Provider responses are redacted from logs.
- Test vectors: `TV-AUTH-002-P`, `TV-AUTH-002-N`
- Notes: Test-only fake bindings are permitted in automated tests.

## AUTH-003

- Priority: P0
- Statement: Browser authentication MUST enforce secure cookies, CSRF, rate limits, and Turnstile risk controls.
- Rationale: Public OTP flows are abuse targets.
- Acceptance criteria:
  - Session cookies are secure, HTTP-only, and correctly scoped.
  - State-changing cookie-authenticated routes reject missing or invalid CSRF.
  - Repeated OTP sends are rate limited.
  - Risk-triggered sends require a valid Turnstile token.
- Test vectors: `TV-AUTH-003-P`, `TV-AUTH-003-N`
- Notes: Rate-limit failures use generic responses where enumeration risk exists.

## AUTH-004

- Priority: P0
- Statement: Every private operation MUST enforce workspace role and visibility authorization before data access.
- Rationale: Tenant filtering after retrieval can leak private metadata.
- Acceptance criteria:
  - Viewer, editor, admin, and owner permissions match the canonical matrix.
  - Cross-workspace IDs return a non-leaking not-found or forbidden result.
  - Search filters unauthorized documents before ranking.
- Test vectors: `TV-AUTH-004-P`, `TV-AUTH-004-N`
- Notes: Service-principal permissions are explicit and never inherit creator privileges.

## AUTH-005

- Priority: P0
- Statement: A Skillplane-owned AuthFn plugin MUST implement a complete OAuth 2.1 authorization server for remote MCP clients.
- Rationale: Standards-compatible remote MCP authentication is required without a broad AuthFn core change.
- Acceptance criteria:
  - The plugin contributes schema, routes, runtime config, and token verification.
  - Authorization metadata, authorization, token, revocation, registration, and consent are implemented.
  - Human grants use an AuthFn session.
  - MCP resource metadata identifies the authorization server.
- Test vectors: `TV-AUTH-005-P`, `TV-AUTH-005-N`
- Notes: Root well-known handlers may be exported by the plugin package and mounted by Hono.

## AUTH-006

- Priority: P0
- Statement: OAuth grants MUST enforce PKCE S256, exact redirects, resource indicators, audience binding, short-lived access tokens, refresh rotation, and reuse detection.
- Rationale: These controls are required for MCP OAuth interoperability and token theft resistance.
- Acceptance criteria:
  - Authorization code redemption succeeds once with the correct verifier and resource.
  - `plain` PKCE, wildcard redirects, mismatched resources, and token query parameters are rejected.
  - Refresh reuse revokes the token family and creates a security event.
- Test vectors: `TV-AUTH-006-P`, `TV-AUTH-006-N`
- Notes: Implicit and password grants are prohibited.

## AUTH-007

- Priority: P0
- Statement: Skillplane MUST support scoped, expirable, revocable credentials for organization-owned service principals.
- Rationale: Some AI agents do not operate through an interactive human session.
- Acceptance criteria:
  - Admins can create a service principal with workspace role and scopes.
  - Secret material is displayed once and stored only as a hash.
  - Revocation immediately denies subsequent requests.
  - Optional delegated user identity is recorded separately.
- Test vectors: `TV-AUTH-007-P`, `TV-AUTH-007-N`
- Notes: Service principals cannot transfer workspace ownership.

## AUTH-008

- Priority: P0
- Statement: The authenticated principal MUST be server-derived while agent, model, client, and run fields MUST be stored as caller-declared metadata.
- Rationale: Required audit metadata must not permit identity spoofing.
- Acceptance criteria:
  - MCP tool schemas require all caller-declaration fields.
  - Supplying a different `userId` cannot change the principal.
  - UI and audit labels distinguish authenticated and declared fields.
- Test vectors: `TV-AUTH-008-P`, `TV-AUTH-008-N`
- Notes: Caller declarations may be analyzed but are not proof of model identity.

## TEN-001

- Priority: P0
- Statement: Every user MUST receive a personal workspace and MAY create or join organization workspaces with owner, admin, editor, or viewer roles.
- Rationale: Accepted defaults require personal and team use.
- Acceptance criteria:
  - First authentication idempotently creates one personal workspace.
  - Organization creation assigns the creator as owner.
  - Membership role changes obey role hierarchy.
- Test vectors: `TV-TEN-001-P`, `TV-TEN-001-N`
- Notes: A user cannot remove the final owner.

## TEN-002

- Priority: P1
- Statement: Workspace invitations MUST be expirable, single-use, role-scoped, and delivered through SendFn.
- Rationale: Organizations require safe member onboarding.
- Acceptance criteria:
  - Invitation tokens are stored hashed and expire.
  - Acceptance requires the authenticated email identity intended by policy.
  - Reuse, expiry, and revoked invitations fail without creating membership.
- Test vectors: `TV-TEN-002-P`, `TV-TEN-002-N`
- Notes: Raw recipient addresses are not written to general logs.

## TEN-003

- Priority: P0
- Statement: Skills MUST support `private`, `workspace`, and `public` visibility with consistent web, API, DataFn, and MCP enforcement.
- Rationale: Accepted defaults require all three visibility modes.
- Acceptance criteria:
  - Private and workspace content is inaccessible to unauthorized principals.
  - Public published versions have shareable web pages.
  - Drafts, candidates, contexts, and notes remain private unless explicitly authorized.
- Test vectors: `TV-TEN-003-P`, `TV-TEN-003-N`
- Notes: Public visibility does not grant amendment rights.

## SKL-001

- Priority: P0
- Statement: Editors MUST be able to create a skill with validated metadata and an initial published bundle.
- Rationale: Skill creation is a core product action.
- Acceptance criteria:
  - Creation writes bundle, skill, revision 1, semantic version `1.0.0`, and release pointer.
  - Workspace slug uniqueness is enforced.
  - Failure leaves no visible partial skill.
- Test vectors: `TV-SKL-001-P`, `TV-SKL-001-N`
- Notes: Orphan R2 cleanup is idempotent.

## SKL-002

- Priority: P0
- Statement: Every skill bundle MUST contain root `SKILL.md` and `skill.json` and MAY contain `assets/`, `references/`, and `scripts/`.
- Rationale: The bundle must be portable, extensible, and compatible with skill-oriented agents.
- Acceptance criteria:
  - Valid bundle manifest lists every file and digest.
  - Missing required files fail validation.
  - Unsupported top-level entries fail with a typed error.
- Test vectors: `TV-SKL-002-P`, `TV-SKL-002-N`
- Notes: Stored scripts are inert artifacts.

## SKL-003

- Priority: P0
- Statement: Bundle canonicalization MUST be deterministic and reject traversal, links, duplicates, bombs, invalid encoding, and configured size-limit violations.
- Rationale: User-provided archives are a critical security boundary.
- Acceptance criteria:
  - Equivalent bundles yield identical canonical bytes and digest.
  - Unsafe paths, symlinks, case-fold collisions, and excessive expansion are rejected before R2 commit.
- Test vectors: `TV-SKL-003-P`, `TV-SKL-003-N`
- Notes: Path normalization uses UTF-8 NFC.

## SKL-004

- Priority: P0
- Statement: Skill revisions and published versions MUST be immutable and monotonically numbered per skill.
- Rationale: Version history must remain trustworthy.
- Acceptance criteria:
  - Updating content creates a new revision.
  - Historical R2 keys and database rows cannot be overwritten.
  - Revision numbers are never reused after failure or rejection.
- Test vectors: `TV-SKL-004-P`, `TV-SKL-004-N`
- Notes: Metadata corrections that affect content or provenance also require a new revision.

## SKL-005

- Priority: P0
- Statement: Published skill versions MUST use semantic versions assigned atomically at publication.
- Rationale: Stable versions are required for retrieval and compatibility.
- Acceptance criteria:
  - First publish is `1.0.0`.
  - Agent amendments default to a patch proposal.
  - Concurrent publication against the same current version yields one winner and a typed conflict.
- Test vectors: `TV-SKL-005-P`, `TV-SKL-005-N`
- Notes: Candidate revisions do not reserve semantic versions.

## SKL-006

- Priority: P0
- Statement: An amendment MUST identify an immutable base version, expected file digests, deterministic file operations, learning metadata, caller declaration, and idempotency key.
- Rationale: Agent improvements must be reviewable, replay-safe, and conflict-safe.
- Acceptance criteria:
  - Valid add, replace, and delete operations create one candidate revision.
  - A stale base or mismatched digest returns `SKILL_VERSION_CONFLICT`.
  - Repeating the same idempotent request returns the original candidate.
- Test vectors: `TV-SKL-006-P`, `TV-SKL-006-N`
- Notes: Amendments never mutate the base bundle.

## SKL-007

- Priority: P0
- Statement: Every modification MUST store structured learning summary, observation, rationale, confidence, evidence or an explicit absence reason, validation, context reference, tags, and bounded extensible metadata.
- Rationale: The user requires additional learning metadata to be stored and shown.
- Acceptance criteria:
  - Required fields are validated and persisted with the revision.
  - Oversized, deeply nested, or secret-like metadata is rejected or redacted.
  - Version UI renders the metadata and provenance.
- Test vectors: `TV-SKL-007-P`, `TV-SKL-007-N`
- Notes: Raw prompts are not learning metadata.

## SKL-008

- Priority: P0
- Statement: Agent amendments MUST create review candidates unless an explicit trusted-credential policy authorizes automatic publication.
- Rationale: Unreviewed self-modification can degrade or poison skills.
- Acceptance criteria:
  - Default policy requires admin or owner approval.
  - Approval and rejection preserve candidate history and reason.
  - Auto-publication evaluates credential, scopes, bump, context, and daily limit.
- Test vectors: `TV-SKL-008-P`, `TV-SKL-008-N`
- Notes: Auto-published revisions still pass full validation.

## SKL-009

- Priority: P1
- Statement: Skills MUST support archive and restore without deleting published history or audit events.
- Rationale: Lifecycle management must be recoverable.
- Acceptance criteria:
  - Archived skills disappear from default lists and current MCP search.
  - Authorized historical retrieval by exact version remains possible.
  - Restore returns the skill to its prior visibility and release pointer.
- Test vectors: `TV-SKL-009-P`, `TV-SKL-009-N`
- Notes: Hard deletion of published versions is prohibited.

## SKL-010

- Priority: P1
- Statement: Skill discovery MUST use authorization-safe Postgres full-text search with deterministic pagination.
- Rationale: Accepted scope includes full-text search and excludes semantic search.
- Acceptance criteria:
  - Search indexes name, description, tags, published instructions, and allowed context metadata.
  - Tenant and visibility filters execute before ranking.
  - Stable ID breaks ranking ties and cursor filters are signed.
- Test vectors: `TV-SKL-010-P`, `TV-SKL-010-N`
- Notes: Vector embeddings are not created.

## CTX-001

- Priority: P0
- Statement: Editors MUST be able to create typed contexts under a skill with unique slug, external reference, metadata, and archive state.
- Rationale: A skill must retain project-specific learning without changing its core.
- Acceptance criteria:
  - Context belongs to exactly one skill.
  - Supported types are repository, project, customer, environment, and custom.
  - Duplicate slug within a skill fails.
- Test vectors: `TV-CTX-001-P`, `TV-CTX-001-N`
- Notes: The same slug may exist under a different skill.

## CTX-002

- Priority: P0
- Statement: Each context MUST maintain one shared Markdown knowledge document through immutable revisions.
- Rationale: Agents need a durable current knowledge surface per context.
- Acceptance criteria:
  - Create produces revision 1.
  - Update requires expected revision and creates the next revision.
  - Revision history remains retrievable by authorized users.
- Test vectors: `TV-CTX-002-P`, `TV-CTX-002-N`
- Notes: Context knowledge does not alter a skill version.

## CTX-003

- Priority: P0
- Statement: Each context MUST support multiple shared named notes with immutable revisions and archive behavior.
- Rationale: Agents need focused notes in addition to the consolidated knowledge document.
- Acceptance criteria:
  - Note create, update, list, history, and archive are implemented.
  - Update requires expected revision.
  - Archived notes are excluded by default but preserve history.
- Test vectors: `TV-CTX-003-P`, `TV-CTX-003-N`
- Notes: Private per-agent notes are explicitly outside scope.

## CTX-004

- Priority: P0
- Statement: Context-aware skill retrieval MUST combine the selected immutable skill version with authorized current or selected context revisions without mutating either.
- Rationale: The PR-review example depends on applying project knowledge at retrieval time.
- Acceptance criteria:
  - Response identifies skill and context revision IDs and digests.
  - Context omission returns only the core skill.
  - Cross-skill or unauthorized context selection fails.
- Test vectors: `TV-CTX-004-P`, `TV-CTX-004-N`
- Notes: Agents use `skill_amend` to promote context learning into the core.

## CTX-005

- Priority: P0
- Statement: Context knowledge and note mutations MUST use optimistic concurrency and idempotency.
- Rationale: Multiple agents may update the same context concurrently.
- Acceptance criteria:
  - Matching base revision commits once.
  - Stale revision returns a typed conflict with current revision.
  - Replayed identical idempotency key returns the original revision.
- Test vectors: `TV-CTX-005-P`, `TV-CTX-005-N`
- Notes: Automatic last-write-wins is forbidden.

## MCP-001

- Priority: P0
- Statement: Skillplane MUST expose a Streamable HTTP MCP server with OAuth protected-resource metadata and standards-compliant authorization challenges.
- Rationale: Skills must be usable by remote AI agents.
- Acceptance criteria:
  - MCP initialization and tool listing work over `/mcp`.
  - Both protected-resource metadata paths resolve.
  - Missing and insufficient credentials return correct `401` or `403` challenges.
- Test vectors: `TV-MCP-001-P`, `TV-MCP-001-N`
- Notes: STDIO transport is Undefined and not required.

## MCP-002

- Priority: P0
- Statement: Every private MCP read or write tool MUST require the complete caller declaration and bind the action to the authenticated principal.
- Rationale: Retrieval and amendment must record agent, model, user, and run context.
- Acceptance criteria:
  - Missing caller field fails schema validation.
  - Caller-supplied user identifiers cannot override credential identity.
  - Audit stores authenticated and declared identities separately.
- Test vectors: `TV-MCP-002-P`, `TV-MCP-002-N`
- Notes: Public web views use server-observed channel metadata instead.

## MCP-003

- Priority: P0
- Statement: `skills_search` MUST return only authorized deterministic full-text results with current version and digest.
- Rationale: Agents need discovery before retrieval.
- Acceptance criteria:
  - Query, visibility, tags, workspace, cursor, and limit are supported.
  - Results include stable skill ID, slug, summary, semantic version, and digest.
  - Unauthorized skills do not affect counts, scores, or cursors.
- Test vectors: `TV-MCP-003-P`, `TV-MCP-003-N`
- Notes: Default limit is 20 and maximum is 100.

## MCP-004

- Priority: P0
- Statement: `skill_retrieve` and `skill_asset_retrieve` MUST return exact authorized version content, manifest, digests, and optional context material with size-safe asset behavior.
- Rationale: Agents require usable instructions and supporting files.
- Acceptance criteria:
  - Stable ID/slug and current/exact version selectors work.
  - Returned digest matches canonical bundle.
  - Unsafe or oversized asset requests fail or use an authorization-bound short-lived download.
  - Every attempt is audited.
- Test vectors: `TV-MCP-004-P`, `TV-MCP-004-N`
- Notes: A different version is never substituted after R2 failure.

## MCP-005

- Priority: P1
- Statement: `skill_versions_list` MUST expose authorized immutable revision history with publication state and learning summary.
- Rationale: Agents need version awareness before amending.
- Acceptance criteria:
  - Cursor, state filters, and limit work.
  - Candidate details require appropriate role.
  - Secret audit values and raw evidence content are not leaked.
- Test vectors: `TV-MCP-005-P`, `TV-MCP-005-N`
- Notes: Public callers see published versions only.

## MCP-006

- Priority: P0
- Statement: `skill_amend` MUST enforce scope, role, policy, base version, file digests, learning metadata, idempotency, bundle validation, and candidate publication semantics.
- Rationale: MCP self-improvement is the defining mutation workflow.
- Acceptance criteria:
  - Valid amendment creates exactly one candidate and audit event.
  - Missing scope, stale base, unsafe path, invalid metadata, or denied policy returns a stable error.
  - Auto-publication occurs only after an explicit policy decision.
- Test vectors: `TV-MCP-006-P`, `TV-MCP-006-N`
- Notes: Tool annotations MUST mark it as mutating.

## MCP-007

- Priority: P0
- Statement: `context_get`, `context_note_upsert`, and `context_notes_list` MUST expose authorized context knowledge and versioned shared notes.
- Rationale: Agents must maintain project-specific context knowledge.
- Acceptance criteria:
  - Read and write scopes are distinct.
  - Upsert create and update semantics are deterministic.
  - Cross-skill context access and stale updates fail.
- Test vectors: `TV-MCP-007-P`, `TV-MCP-007-N`
- Notes: Context knowledge update uses the corresponding API/domain operation even if exposed as a separate tool later.

## MCP-008

- Priority: P0
- Statement: MCP errors, pagination, and retryable mutations MUST use stable machine-readable codes, opaque cursors, and idempotency conflict rules.
- Rationale: Agents need deterministic recovery behavior.
- Acceptance criteria:
  - Domain errors map to `isError: true` with safe structured content.
  - Cursor filter mismatch and idempotency-key reuse produce stable errors.
  - Internal stack or provider text is absent.
- Test vectors: `TV-MCP-008-P`, `TV-MCP-008-N`
- Notes: Human-readable messages may improve without changing codes.

## AUD-001

- Priority: P0
- Statement: Every skill retrieval, asset retrieval, amendment, context read, and context write MUST append an attributable audit event before private content is disclosed or mutation success is acknowledged.
- Rationale: Auditability is a core invariant.
- Acceptance criteria:
  - Event contains principal, credential, caller declaration, resource/version/context, request ID, outcome, and latency.
  - Audit failure fails closed for private retrieval and security-sensitive mutation.
  - Denied attempts record safe minimal events.
- Test vectors: `TV-AUD-001-P`, `TV-AUD-001-N`
- Notes: Audit events do not contain returned content.

## AUD-002

- Priority: P0
- Statement: Detailed retrieval events MUST expire after 90 days while permanent mutation/security history and daily aggregates MUST be retained.
- Rationale: The accepted default balances analytics and privacy.
- Acceptance criteria:
  - Retention job deletes only eligible detailed events.
  - Amendment, publication, membership, and OAuth security events remain.
  - Aggregate counts remain stable after detail expiry.
- Test vectors: `TV-AUD-002-P`, `TV-AUD-002-N`
- Notes: Retention execution is itself audited.

## AUD-003

- Priority: P1
- Statement: Skillplane MUST compute idempotent daily analytics for retrievals, principals, declared agents/models, contexts, amendments, approvals, failures, adoption, and latency.
- Rationale: The user requires audit logs and analytics for agent/model usage.
- Acceptance criteria:
  - Re-running a day does not double count.
  - Tenant and visibility boundaries are preserved.
  - Raw prompts and skill bodies never enter aggregates.
- Test vectors: `TV-AUD-003-P`, `TV-AUD-003-N`
- Notes: Postgres is the analytics store in this scope.

## AUD-004

- Priority: P1
- Statement: The app MUST present filterable audit and analytics views with declared-metadata labeling and safe export behavior.
- Rationale: Stored metadata must be visible and useful in the UI.
- Acceptance criteria:
  - Views filter by time, skill, context, tool, outcome, agent, and model.
  - Caller-declared fields are visually identified.
  - Export obeys role, tenant, filter, and redaction rules.
- Test vectors: `TV-AUD-004-P`, `TV-AUD-004-N`
- Notes: Viewer role cannot access detailed audit.

## UI-001

- Priority: P1
- Statement: Shared UI MUST implement a Linear-inspired Tailwind design system using Phosphor icons, semantic tokens, compact density, and light/dark themes.
- Rationale: The user specified the frontend stack and visual direction.
- Acceptance criteria:
  - Tokens and primitives live in `packages/ui`.
  - Feature pages use semantic colors and standardized icon sizes.
  - Both themes meet contrast requirements.
- Test vectors: `TV-UI-001-P`, `TV-UI-001-N`
- Notes: Proprietary Linear assets are not copied.

## UI-002

- Priority: P0
- Statement: The authenticated app MUST provide complete backed surfaces for workspaces, skills, content, versions, diffs, contexts, notes, amendment review, MCP connections, members, analytics, audit, and settings.
- Rationale: These surfaces are required to operate the product.
- Acceptance criteria:
  - Navigation reaches every surface.
  - Every mutation persists through reload.
  - Permissions hide and enforce unavailable actions.
- Test vectors: `TV-UI-002-P`, `TV-UI-002-N`
- Notes: UI authorization never substitutes for server authorization.

## UI-003

- Priority: P1
- Statement: The landing application MUST accurately present creation, contexts, MCP retrieval, controlled amendment, versioning, audit, security, public skills, and authentication calls to action.
- Rationale: A standalone landing page is required.
- Acceptance criteria:
  - All claims map to shipped functionality.
  - Public skill discovery and auth links work.
  - Metadata, canonical URLs, social cards, sitemap, and robots behavior are configured.
- Test vectors: `TV-UI-003-P`, `TV-UI-003-N`
- Notes: Billing and marketplace claims are prohibited.

## UI-004

- Priority: P0
- Statement: App and landing interfaces MUST meet WCAG 2.2 AA and remain usable from narrow mobile to desktop viewports.
- Rationale: Production readiness includes accessibility and responsive behavior.
- Acceptance criteria:
  - Keyboard, focus, labels, dialogs, error association, contrast, reduced motion, and landmarks pass.
  - No core workflow requires hover or a desktop-only viewport.
  - Automated and manual accessibility checks are recorded.
- Test vectors: `TV-UI-004-P`, `TV-UI-004-N`
- Notes: Dense data tables may use responsive alternate layouts.

## UI-005

- Priority: P0
- Statement: Every user-facing data workflow MUST implement loading, empty, success, validation, authorization, error, retry, and destructive-confirmation states.
- Rationale: Missing states are functional defects, not polish.
- Acceptance criteria:
  - Network and server failures produce actionable retry behavior.
  - Optimistic updates reconcile or roll back deterministically.
  - Destructive confirmation explains preserved history.
- Test vectors: `TV-UI-005-P`, `TV-UI-005-N`
- Notes: Screenshots of representative states are required evidence.

## OPS-001

- Priority: P0
- Statement: Local development MUST start a health-checked Docker Postgres service on configured port 5432 by default and MUST fail clearly on port conflict.
- Rationale: The user requires a real local Postgres instance.
- Acceptance criteria:
  - Preflight checks Docker engine and configured port.
  - Container uses a named volume and non-default application credentials.
  - Health check gates migrations and app startup.
- Test vectors: `TV-OPS-001-P`, `TV-OPS-001-N`
- Notes: A developer may explicitly set another deterministic port.

## OPS-002

- Priority: P0
- Statement: Production Workers MUST connect to Railway Postgres only through the user-provided Cloudflare Hyperdrive binding.
- Rationale: Railway is the origin and Hyperdrive is the required Worker connection layer.
- Acceptance criteria:
  - Worker code uses the binding connection string.
  - Production deployment refuses a missing Hyperdrive ID.
  - Migrations connect directly to Railway outside Hyperdrive.
- Test vectors: `TV-OPS-002-P`, `TV-OPS-002-N`
- Notes: The Hyperdrive ID is an external deployment input, not a committed placeholder.

## OPS-003

- Priority: P0
- Statement: Production MUST deploy landing, app, and MCP Workers to `skillplane.dev`, `app.skillplane.dev`, and `mcp.skillplane.dev`.
- Rationale: Accepted deployment defaults define clear trust and caching boundaries.
- Acceptance criteria:
  - DNS routes and TLS resolve for all three hosts.
  - Auth cookies and CORS are host-scoped correctly.
  - MCP metadata uses the canonical production resource URI.
- Test vectors: `TV-OPS-003-P`, `TV-OPS-003-N`
- Notes: Preview hosts must not issue production-audience tokens.

## OPS-004

- Priority: P0
- Statement: Environment configuration MUST be schema-validated and production secrets MUST remain in Cloudflare or deployment secret stores.
- Rationale: Missing or leaked bindings would compromise authentication and data.
- Acceptance criteria:
  - Startup fails with stable diagnostics for missing required bindings.
  - Browser bundles contain no server secret.
  - Committed examples contain names and descriptions but no usable secrets or fake production IDs.
- Test vectors: `TV-OPS-004-P`, `TV-OPS-004-N`
- Notes: Local `.dev.vars` is ignored.

## OPS-005

- Priority: P1
- Statement: Caching and indexing MUST meet the specified latency targets without caching authorization decisions, audit writes, mutable release pointers, or private responses unsafely.
- Rationale: Performance cannot weaken consistency or tenant isolation.
- Acceptance criteria:
  - Required database indexes exist and are explained by query plans.
  - Immutable public/versioned data uses digest-based caching.
  - Sensitive/mutable responses use `private, no-store`.
- Test vectors: `TV-OPS-005-P`, `TV-OPS-005-N`
- Notes: Hyperdrive query caching is opt-in for proven safe reads.

## OPS-006

- Priority: P0
- Statement: Migrations, backups, orphan cleanup, token recovery, and disaster procedures MUST be executable and verified against local Postgres and R2 fixtures.
- Rationale: Production-ready persistence includes recovery, not only creation.
- Acceptance criteria:
  - Fresh migration, upgrade migration, and rollback/restore rehearsal are documented and tested.
  - Orphan R2 cleanup deletes only unreferenced digests.
  - Database backup and R2 inventory can reconstruct version metadata references.
- Test vectors: `TV-OPS-006-P`, `TV-OPS-006-N`
- Notes: Published version bytes remain immutable.

## QA-001

- Priority: P0
- Statement: Every domain invariant, schema, adapter, authorization rule, OAuth flow, bundle validator, and MCP tool MUST have deterministic automated tests.
- Rationale: Production correctness must be reproducible without manual inference.
- Acceptance criteria:
  - Unit and integration suites cover positive, negative, boundary, and concurrency behavior.
  - Test-only doubles cannot enter production bundles.
  - Tests run from the repository root.
- Test vectors: `TV-QA-001-P`, `TV-QA-001-N`
- Notes: Coverage percentage alone is not acceptance.

## QA-002

- Priority: P0
- Statement: Playwright E2E tests MUST verify critical browser workflows against real Hono, Postgres, R2-local, AuthFn, and DataFn paths.
- Rationale: UI receipts without persistence do not prove product behavior.
- Acceptance criteria:
  - Tests cover OTP, workspace, skill, version, context, amendment review, credentials, analytics, and public pages.
  - Each write verifies immediate UI state and state after reload.
  - Network failures and authorization denial are exercised.
- Test vectors: `TV-QA-002-P`, `TV-QA-002-N`
- Notes: Cloudflare Email delivery itself is integration-tested separately.

## QA-003

- Priority: P0
- Statement: Security tests MUST cover tenant isolation, OAuth attacks, credential leakage, archive attacks, Markdown sanitization, rate limits, CSRF, and audit redaction.
- Rationale: The product accepts untrusted archives and grants agent access.
- Acceptance criteria:
  - Cross-tenant matrices return no protected content.
  - OAuth redirect, PKCE, replay, refresh reuse, and resource confusion attacks fail.
  - Malicious bundles and Markdown are rejected or sanitized.
- Test vectors: `TV-QA-003-P`, `TV-QA-003-N`
- Notes: Security tests are release-blocking.

## QA-004

- Priority: P0
- Statement: No phase MAY be marked complete until its commands, manual observations, screenshots where applicable, and `.conduct` evidence are recorded.
- Rationale: Completion must be evidence-backed.
- Acceptance criteria:
  - Phase report lists requirements, files, commands, outputs, and remaining risks.
  - Ledger links the report and evidence.
  - Failed or blocked verification leaves the phase incomplete.
- Test vectors: `TV-QA-004-P`, `TV-QA-004-N`
- Notes: A green build without required behavioral evidence is insufficient.
