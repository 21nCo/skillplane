# Metadata

- Timestamp: `2026-07-25T05:19:58Z`
- Agent name: `Codex`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: `repo root`
- OS: `Darwin arm64`
- Shell: `zsh`
- Repository metadata: project directory was not a Git repository at specification time
- Spec folder: `2026-07-25-new-17dd6c3e-spec`
- Spec path: `.conduct/specs/2026-07-25-new-17dd6c3e-spec`
- Spec type: `new`
- Spec ID: `17dd6c3e`
- Inputs:
  - user-provided Skillplane product intent and accepted defaults
  - Superfunctions `dev` worktree AuthFn and DataFn source
  - Superfunctions `next` worktree SendFn source
  - Nucleus account-service AuthFn, DataFn, and SendFn composition
  - Model Context Protocol authorization specification, stable revision `2025-11-25`
  - Cloudflare Email Service, Hyperdrive, and R2 documentation

# Overview

Skillplane is a production skill-management platform where humans and authorized AI agents create, publish, retrieve, contextualize, analyze, and improve reusable AI skills. Every published skill artifact is immutable and versioned. Every amendment records structured learning provenance. Every MCP retrieval and mutation is attributed to an authenticated principal and caller-declared agent, model, client, and run metadata.

Skillplane MUST be delivered as a pnpm/Turborepo monorepo containing:

```text
app/
landing/
mcp/
packages/
```

`app/` and `landing/` MUST be SvelteKit applications. Shared backend composition MUST use Hono. Production workloads MUST run on Cloudflare Workers. Relational state MUST use Railway Postgres through Cloudflare Hyperdrive. Local development MUST use a real Docker Postgres database. Immutable skill bundles MUST use Cloudflare R2. Authentication MUST use AuthFn. Typed application data management MUST use DataFn. OTP email MUST use SendFn through a Cloudflare Email Service adapter.

The system MUST NOT contain placeholder routes, sample-only data, nonfunctional controls, stub service implementations, fake production adapters, or scaffold-only screens. Test-only doubles MAY exist only inside automated test code.

# Context

- Project name: Skillplane
- One-sentence goal: provide a production control plane for reusable, versioned, context-aware AI skills that authorized agents can retrieve and improve through MCP with complete provenance.
- Target users:
  - individual skill authors;
  - organization administrators and editors;
  - reviewers who approve agent amendments;
  - interactive AI agents acting for authenticated users;
  - organization-owned service agents.
- Target environments:
  - modern evergreen browsers;
  - Cloudflare Workers;
  - local macOS or Linux development with Docker;
  - remote MCP clients using Streamable HTTP;
  - online-only server authority, with resilient client loading and retry behavior.
- Languages and packages:
  - TypeScript;
  - SvelteKit;
  - Hono;
  - Tailwind CSS;
  - Phosphor Svelte icons;
  - MCP TypeScript SDK;
  - AuthFn, DataFn, SendFn;
  - Drizzle-compatible Postgres adapter;
  - Vitest and Playwright.
- Existing systems:
  - Superfunctions AuthFn and DataFn from the `dev` worktree;
  - Superfunctions SendFn from the `next` worktree;
  - Cloudflare Workers, Hyperdrive, R2, Email Service, and Turnstile;
  - Railway Postgres.
- Security model:
  - multi-tenant organizations;
  - personal workspaces;
  - role-based authorization;
  - OAuth 2.1 and scoped API credentials;
  - append-only security and audit events;
  - no raw prompt retention by default.
- Performance baseline:
  - p95 authenticated metadata reads below 500 ms from the Worker under normal service conditions;
  - p95 MCP retrieval below 1 second for a cached metadata path and a skill bundle up to 1 MiB;
  - support at least 10,000 skills, 100 versions per skill, 100 contexts per skill, and 1 million detailed audit events per organization without changing the public API.
- Non-goals:
  - billing;
  - a commercial marketplace;
  - semantic or vector search;
  - arbitrary code execution from skill scripts;
  - private per-agent context notes;
  - collaborative inline comments.
- Hard constraints:
  - no stubs or scaffolding-only delivery;
  - no broad Superfunctions changes;
  - every Superfunctions change is separately logged under `.conduct/logs/superfunctions/`;
  - `.conduct` evidence begins before implementation and remains append-only;
  - production secrets MUST never enter Git, logs, screenshots, browser bundles, or audit payloads.

# Glossary

- **Principal**: authenticated user or organization-owned service identity.
- **User principal**: AuthFn user session or user-bound OAuth/API credential.
- **Service principal**: organization-owned non-human identity with explicitly granted scopes.
- **Caller declaration**: agent and model metadata supplied by an MCP caller. It is auditable but not cryptographically authoritative.
- **Workspace**: either an automatically created personal workspace or an organization.
- **Skill**: stable logical identity with slug, ownership, visibility, metadata, and version history.
- **Skill bundle**: deterministic archive containing `SKILL.md`, `skill.json`, and optional `assets/`, `references/`, and `scripts/`.
- **Revision**: monotonically increasing immutable version record, including unpublished candidates.
- **Published version**: immutable revision assigned a semantic version and eligible for normal retrieval.
- **Candidate version**: immutable proposed revision awaiting approval or trusted auto-publication.
- **Learning metadata**: structured explanation, evidence, confidence, context, validation, and extensible data attached to a modification.
- **Context**: a named skill-specific namespace representing a project, repository, customer, environment, or custom scope.
- **Context knowledge**: the current shared Markdown knowledge document for a context, backed by immutable revisions.
- **Context note**: independently named shared note within a context, backed by immutable revisions.
- **Amendment**: authorized request that creates a candidate skill revision from an explicit base revision.
- **Release pointer**: transactionally updated reference to the current published skill version.
- **Audit event**: append-only event describing an authenticated or attempted action.
- **Detailed retrieval event**: time-limited audit record for one skill or asset retrieval.
- **Aggregate**: privacy-preserving daily metric retained after detailed retrieval-event expiry.
- **MCP resource server**: the `mcp.skillplane.dev` Worker that validates audience-bound credentials and exposes Skillplane tools.
- **OAuth authorization server plugin**: Skillplane-owned AuthFn plugin implementing OAuth authorization endpoints and token persistence.

# Goals

1. Humans MUST be able to create, edit, review, publish, archive, restore, and inspect skills.
2. Agents MUST be able to search, retrieve, amend, and contextualize skills through MCP.
3. Every skill version and context revision MUST be immutable and attributable.
4. Retrievals and amendments MUST produce audit and analytics events.
5. Context knowledge MUST remain independent from the core skill until an explicit amendment incorporates it.
6. Authentication, authorization, storage, email, and deployment MUST be real production integrations.
7. The UI MUST expose version diffs, learning metadata, contexts, analytics, and audit history.
8. The project MUST maintain reproducible engineering evidence in `.conduct`.

# Non-goals

The accepted product scope explicitly excludes billing, a commercial marketplace, semantic/vector search, arbitrary execution of stored scripts, private per-agent notes, and inline collaborative comments. Public skills still MUST have shareable pages and full-text discoverability; exclusion of a marketplace does not make public skills inaccessible.

# Architecture

## Monorepo

```text
app/                         authenticated SvelteKit application
landing/                     public SvelteKit site
mcp/                         Hono + MCP Streamable HTTP Worker
packages/api/                canonical Hono application and endpoint mounting
packages/auth/               AuthFn composition and principal resolution
packages/authfn-mcp-oauth/   Skillplane-owned AuthFn OAuth authorization-server plugin
packages/config/             environment parsing and deployment contracts
packages/db/                 Postgres schema, migrations, and transaction helpers
packages/domain/             authorization and business services
packages/email/              SendFn composition and OTP renderer
packages/mcp-schema/         tool schemas, responses, and error mapping
packages/observability/      structured logs, audit events, and metrics
packages/storage/            R2 bundle validation and content-addressed storage
packages/testing/            test-only fixtures and Worker/Postgres harnesses
packages/ui/                 Linear-inspired design tokens and Svelte components
```

The root package manager MUST be pnpm and orchestration MUST use Turborepo. Package boundaries MUST be enforced with TypeScript project references or equivalent workspace checks. Application packages MUST consume shared packages rather than duplicate domain logic.

## Runtime topology

- `skillplane.dev`: Cloudflare Worker serving `landing/`.
- `app.skillplane.dev`: Cloudflare Worker serving `app/` and mounting the shared Hono backend at `/api/v1`, `/auth`, and `/datafn`.
- `mcp.skillplane.dev`: separate Cloudflare Worker serving `/mcp` and OAuth protected-resource metadata.
- Railway: managed Postgres origin.
- Hyperdrive: Worker binding providing production Postgres connection strings.
- R2: private bucket containing content-addressed skill bundles.
- Email Service: Worker binding used by SendFn for OTP and invitation delivery.

The app and MCP Workers MUST share domain packages but MUST have distinct bindings, scopes, CORS policies, and deployment configurations.

## Local topology

- Docker Postgres MUST default to `127.0.0.1:5432`.
- Startup MUST check the configured port before creating the container.
- If port 5432 is occupied, the developer MUST select a deterministic `SKILLPLANE_POSTGRES_PORT`; scripts MUST NOT silently choose a random port.
- Local R2 MUST use Wrangler's persisted local R2 implementation.
- Local email integration tests MUST use a test-only fake binding; manual OTP validation MUST use Cloudflare remote binding or an explicit Email Service test destination.
- Production application code MUST never branch to a fake email provider.

# Data model

## AuthFn-owned tables

AuthFn MUST own users, sessions, OTP challenges, API keys, and its existing authentication tables.

The Skillplane OAuth plugin MUST contribute:

- `oauth_clients`;
- `oauth_client_redirect_uris`;
- `oauth_consents`;
- `oauth_authorization_codes`;
- `oauth_access_tokens`;
- `oauth_refresh_tokens`.

All secrets, codes, access tokens, and refresh tokens MUST be stored only as keyed hashes. Plaintext credentials MUST be returned only at issuance and MUST not be recoverable.

## Skillplane domain tables

- `workspaces`
  - `id`, `kind`, `name`, `slug`, `created_by`, timestamps.
- `workspace_memberships`
  - `workspace_id`, `user_id`, `role`, status, timestamps.
- `workspace_invitations`
  - token hash, email hash and encrypted delivery value, role, expiry, inviter, acceptance state.
- `service_principals`
  - workspace, name, status, owner, metadata, timestamps.
- `skills`
  - workspace, slug, name, description, visibility, status, current published version, amendment policy, tags, timestamps.
- `skill_versions`
  - skill, revision number, semantic version nullable until publish, state, base version, R2 key, bundle digest, manifest, learning metadata, author principal, caller declaration, timestamps.
- `skill_version_files`
  - version, normalized path, digest, media type, byte size.
- `skill_contexts`
  - skill, slug, name, type, external reference, metadata, status, timestamps.
- `context_knowledge_revisions`
  - context, revision number, base revision, body digest, body, author principal, caller declaration, learning metadata, timestamps.
- `context_notes`
  - context, stable note identity, title, status, current revision, timestamps.
- `context_note_revisions`
  - note, revision number, base revision, body digest, body, author principal, caller declaration, timestamps.
- `amendment_reviews`
  - candidate version, reviewer, decision, reason, timestamps.
- `audit_events`
  - workspace, principal, credential, channel, event type, resource references, caller declaration, request ID, outcome, error code, latency, IP hash, user-agent family, timestamp, retention class.
- `analytics_daily`
  - workspace, date, skill/context/tool dimensions, counts, latency buckets, unique-principal sketches or exact bounded counts.
- `idempotency_records`
  - workspace, principal, operation, key hash, request digest, response reference, expiry.

Foreign keys MUST enforce ownership. Tenant-scoped uniqueness MUST include `workspace_id`. Historical version and audit references MUST use stable IDs rather than mutable slugs.

# Public API

## HTTP envelope

Successful JSON responses MUST use:

```json
{
  "ok": true,
  "data": {},
  "meta": {
    "requestId": "req_01",
    "nextCursor": null
  }
}
```

Failed JSON responses MUST use:

```json
{
  "ok": false,
  "error": {
    "code": "SKILL_VERSION_CONFLICT",
    "message": "The base version is no longer current.",
    "requestId": "req_01",
    "details": {
      "currentRevision": 8
    }
  }
}
```

Production `message` values MUST be safe for end users. Stack traces, SQL, object keys, secrets, tokens, raw email addresses, and internal provider responses MUST not be returned.

## App and API endpoints

### Authentication

- `POST /auth/otp/send`
- `POST /auth/otp/verify`
- `GET /auth/session`
- `POST /auth/sign-out`
- AuthFn API-key lifecycle routes
- OAuth endpoints defined below

OTP sending MUST be protected by rate limiting, normalized identifiers, generic anti-enumeration responses, and Turnstile policy where risk thresholds require it.

### Workspaces

- `GET /api/v1/workspaces`
- `POST /api/v1/workspaces`
- `GET /api/v1/workspaces/:workspaceId`
- `PATCH /api/v1/workspaces/:workspaceId`
- `GET /api/v1/workspaces/:workspaceId/members`
- `POST /api/v1/workspaces/:workspaceId/invitations`
- `POST /api/v1/invitations/:token/accept`
- `PATCH /api/v1/workspaces/:workspaceId/members/:userId`
- `DELETE /api/v1/workspaces/:workspaceId/members/:userId`

### Skills

- `GET /api/v1/workspaces/:workspaceId/skills`
- `POST /api/v1/workspaces/:workspaceId/skills`
- `GET /api/v1/skills/:skillId`
- `PATCH /api/v1/skills/:skillId`
- `POST /api/v1/skills/:skillId/archive`
- `POST /api/v1/skills/:skillId/restore`
- `GET /api/v1/skills/:skillId/versions`
- `GET /api/v1/skills/:skillId/versions/:versionId`
- `POST /api/v1/skills/:skillId/versions`
- `POST /api/v1/skills/:skillId/candidates/:versionId/approve`
- `POST /api/v1/skills/:skillId/candidates/:versionId/reject`
- `GET /api/v1/skills/:skillId/versions/:versionId/files/:path`
- `GET /api/v1/skills/:skillId/diff?from=:versionId&to=:versionId`

### Contexts

- `GET /api/v1/skills/:skillId/contexts`
- `POST /api/v1/skills/:skillId/contexts`
- `GET /api/v1/contexts/:contextId`
- `PATCH /api/v1/contexts/:contextId`
- `POST /api/v1/contexts/:contextId/archive`
- `GET /api/v1/contexts/:contextId/knowledge`
- `PUT /api/v1/contexts/:contextId/knowledge`
- `GET /api/v1/contexts/:contextId/notes`
- `POST /api/v1/contexts/:contextId/notes`
- `PUT /api/v1/context-notes/:noteId`
- `POST /api/v1/context-notes/:noteId/archive`

### Analytics and audit

- `GET /api/v1/workspaces/:workspaceId/analytics`
- `GET /api/v1/workspaces/:workspaceId/audit-events`
- `GET /api/v1/skills/:skillId/analytics`
- `GET /api/v1/skills/:skillId/audit-events`

Audit endpoints MUST be cursor-paginated, role-protected, filterable, and redacted.

## OAuth authorization-server plugin

The AuthFn plugin MUST implement:

- `GET /.well-known/oauth-authorization-server`
- `GET /.well-known/openid-configuration` only if OpenID fields are actually supported; otherwise it MUST return `404`
- `GET /auth/oauth/authorize`
- `POST /auth/oauth/token`
- `POST /auth/oauth/revoke`
- `POST /auth/oauth/register`
- `GET /auth/oauth/clients/:clientId`
- `GET /auth/oauth/consent`
- `POST /auth/oauth/consent`

The authorization server MUST support:

- authorization code grant with PKCE S256;
- exact redirect URI matching;
- `state`;
- resource indicators;
- audience-bound access tokens;
- refresh-token rotation and reuse detection;
- client ID metadata documents;
- dynamic registration for public MCP clients;
- scoped consent;
- revocation;
- rate limiting;
- AuthFn cookie sessions for human authorization.

The authorization server MUST NOT support implicit grant, password grant, PKCE `plain`, wildcard redirect URIs, bearer tokens in query strings, or unbound access tokens.

The canonical MCP resource identifier MUST be:

```text
https://mcp.skillplane.dev/mcp
```

Supported scopes MUST include:

```text
skills:read
skills:amend
contexts:read
contexts:write
audit:read
```

## MCP protected-resource metadata

`mcp.skillplane.dev` MUST expose:

```text
GET /.well-known/oauth-protected-resource
GET /.well-known/oauth-protected-resource/mcp
```

Both documents MUST identify the canonical MCP resource and the Skillplane authorization server. Unauthorized MCP requests MUST return `401` with a standards-compliant `WWW-Authenticate` challenge. Insufficient scopes MUST return `403` with the required scope.

## MCP caller declaration

Every private skill retrieval, asset retrieval, amendment, context read, and context write tool MUST require:

```json
{
  "caller": {
    "agentId": "agent_instance_123",
    "agentName": "Codex",
    "modelProvider": "OpenAI",
    "modelName": "gpt-5",
    "modelVersion": "2026-07-01",
    "clientName": "Codex Desktop",
    "clientVersion": "1.0.0",
    "runId": "run_123",
    "sessionId": "session_123",
    "conversationId": "conversation_123"
  }
}
```

All properties are required for MCP calls. Values MUST be length-limited, normalized, and treated as caller-declared. The authenticated user or service principal MUST be derived from the credential and MUST never be selected by this object.

## MCP tools

### `skills_search`

Input:

```json
{
  "query": "pull request review",
  "workspaceId": "ws_123",
  "visibility": ["private", "workspace", "public"],
  "tags": ["review"],
  "cursor": null,
  "limit": 20,
  "caller": {}
}
```

Output MUST contain authorized skill summaries, current semantic versions, digests, and a cursor. Search MUST use Postgres full-text search and deterministic secondary ordering by stable skill ID.

### `skill_retrieve`

Input:

```json
{
  "skill": {
    "id": "skill_123"
  },
  "version": {
    "selector": "current"
  },
  "context": {
    "id": "ctx_123",
    "includeNotes": true
  },
  "caller": {}
}
```

The skill selector MUST accept exactly one of stable ID or `{workspaceSlug, skillSlug}`. Version selector MUST accept exactly one of `current`, semantic version, revision number, or version ID. Context is optional. The response MUST include instructions, manifest, version metadata, bundle digest, file descriptors, selected context knowledge, selected shared notes, and audit request ID.

### `skill_asset_retrieve`

Input MUST identify skill version, normalized relative path, and caller. It MUST return text or base64 content only when the media type and size are MCP-safe. Oversized assets MUST return a short-lived authenticated download URL or a typed size error according to client capability.

### `skill_versions_list`

Input MUST identify a skill, cursor, limit, states, and caller. Output MUST include immutable revision history, publication state, semantic version, learning summary, author type, and digest without returning secret audit fields.

### `skill_amend`

Input:

```json
{
  "skillId": "skill_123",
  "baseVersionId": "sv_007",
  "idempotencyKey": "amend-run_123-attempt_1",
  "proposedBump": "patch",
  "changes": [
    {
      "operation": "replace",
      "path": "SKILL.md",
      "expectedSha256": "base-file-digest",
      "content": "# Updated skill"
    }
  ],
  "learning": {
    "summary": "Clarify stale review-thread handling",
    "observation": "A project used server-side review threads not visible in local diffs.",
    "rationale": "The skill must inspect live review threads before concluding there is no feedback.",
    "confidence": "high",
    "evidence": [
      {
        "kind": "run",
        "reference": "run_123",
        "description": "The live-thread check changed the result."
      }
    ],
    "validation": [
      {
        "kind": "manual",
        "status": "passed",
        "description": "Replayed against two repositories."
      }
    ],
    "sourceContextId": "ctx_123",
    "tags": ["github", "review-threads"],
    "extra": {}
  },
  "caller": {}
}
```

File operations MUST support `add`, `replace`, and `delete`. Paths MUST be normalized and traversal-safe. `baseVersionId`, expected digests, and idempotency key are mandatory. Successful amendment MUST create one immutable candidate revision. It MUST NOT mutate or overwrite the base version.

### `context_get`

Input MUST identify skill, context, optional knowledge revision, note inclusion, and caller. Output MUST contain context metadata, immutable knowledge revision, and authorized shared notes.

### `context_note_upsert`

Input MUST identify context, optional stable note ID, expected current revision for updates, title, Markdown body, idempotency key, and caller. Create MUST produce note revision 1. Update MUST produce the next immutable note revision.

### `context_notes_list`

Input MUST identify context, cursor, limit, status filter, and caller. Output MUST be deterministically ordered by latest update descending and stable note ID.

# Semantics

## Skill creation

Creating a skill MUST:

1. authorize `editor` or higher in the target workspace;
2. reserve a workspace-unique normalized slug;
3. validate the bundle;
4. produce a deterministic bundle digest;
5. write the content-addressed bundle to R2;
6. create skill and first version records in one Postgres transaction;
7. publish semantic version `1.0.0`;
8. set the release pointer;
9. append an audit event.

If the Postgres transaction fails after R2 upload, the object is an orphan candidate and MUST be removed by idempotent cleanup. If the R2 upload fails, no database version record may be committed.

## Deterministic bundle

The canonical archive MUST:

- use UTF-8 path names normalized to NFC;
- sort entries by bytewise normalized path;
- set deterministic timestamps and permissions;
- reject duplicate case-folded paths;
- reject absolute paths, parent traversal, symlinks, devices, and hard links;
- require `SKILL.md` and `skill.json` at the root;
- include a manifest file list and SHA-256 digest;
- never execute stored scripts during validation or retrieval.

Two logically identical input bundles MUST produce the same canonical bytes and digest.

## Versioning

- `revision_number` MUST increase monotonically per skill and MUST never be reused.
- Candidate creation MUST reserve a revision number but MUST not reserve a semantic version.
- Approval MUST calculate the next semantic version from the then-current published version and the approved bump.
- Automatic agent amendments MUST propose `patch` unless the credential policy explicitly permits another bump.
- Publishing MUST atomically assign semantic version, mark the revision published, and update the release pointer.
- Rejection MUST preserve the immutable candidate and record the decision.
- Published versions MUST never be edited or deleted through the product.
- Concurrent publish conflicts MUST fail with `SKILL_PUBLISH_CONFLICT` and leave both candidates unchanged.

## Amendment policy

Each skill MUST have:

- `review_required` by default;
- optional trusted credential policies permitting automatic publication;
- allowed scopes;
- maximum bump;
- optional context restriction;
- optional daily amendment limit.

Auto-publication MUST still create an immutable candidate, validate it, record learning metadata, and perform an explicit policy decision before publishing.

## Learning metadata

Learning metadata MUST include:

- `summary`;
- `observation`;
- `rationale`;
- `confidence`: `low`, `medium`, or `high`;
- `evidence`: non-empty, or an explicit `evidenceUnavailableReason`;
- `validation`: possibly empty only when status is explicitly `not-run` with reason;
- optional `sourceContextId`;
- optional tags and external references;
- extensible `extra` JSON capped by size and depth.

The UI MUST display learning metadata beside the version diff and in the version timeline. It MUST clearly label caller-declared agent/model values.

## Context semantics

- A context belongs to exactly one skill.
- Context slug is unique within the skill.
- A context can be `repository`, `project`, `customer`, `environment`, or `custom`.
- Context knowledge is one shared Markdown document with immutable revisions.
- Context notes are multiple shared named documents with immutable revisions.
- Context edits MUST use optimistic concurrency.
- Retrieving a skill with a context MUST not modify the skill.
- Incorporating context learning into the skill requires `skill_amend`.
- Archiving a context MUST hide it from default retrieval while preserving history.
- Private per-agent notes are explicitly outside the accepted scope.

## Search

Full-text search MUST index skill name, description, tags, published `SKILL.md`, context names, and public metadata according to authorization. Search MUST not index private audit metadata or caller declarations. Results MUST be tenant-filtered before ranking.

## Pagination

List endpoints and tools MUST use opaque signed cursors. Cursors MUST include normalized filter digest and sort boundary. Reusing a cursor with different filters MUST fail with `CURSOR_FILTER_MISMATCH`. Default limit MUST be 20 and maximum 100.

## Idempotency

All externally retryable mutations MUST require an idempotency key. Repeating the same key with the same normalized request MUST return the original resource. Repeating it with a different request digest MUST return `IDEMPOTENCY_KEY_REUSED`.

# Invariants

1. A published skill version is immutable.
2. An R2 bundle key is content-addressed and never overwritten with different bytes.
3. A release pointer references one published version in the same skill.
4. Every MCP read or write has an authenticated principal, credential identifier, caller declaration, and audit event.
5. Caller-declared user identity is never authoritative.
6. A context never belongs to more than one skill.
7. A context revision never mutates the core skill.
8. Tenant authorization occurs before content retrieval or search ranking.
9. Detailed audit events never contain raw skill content, prompt text, OTP codes, cookies, tokens, email bodies, or database credentials.
10. Every mutation is either fully committed or safely retryable without duplicate versions.
11. Timestamps are stored in UTC and serialized as RFC 3339.
12. User-facing ordering has a stable ID tie-breaker.

# Authorization

## Roles

| Capability | Viewer | Editor | Admin | Owner |
|---|---:|---:|---:|---:|
| Retrieve workspace skills | Yes | Yes | Yes | Yes |
| Create skill/context/note | No | Yes | Yes | Yes |
| Create candidate amendment | No | Yes | Yes | Yes |
| Approve or reject candidate | No | No | Yes | Yes |
| Manage members/invitations | No | No | Yes | Yes |
| Manage service principals and policies | No | No | Yes | Yes |
| Transfer ownership | No | No | No | Yes |
| Read detailed audit | No | No | Yes | Yes |

Personal workspaces MUST assign the user as owner. Service principals MUST receive explicit workspace role and OAuth/API scopes; they MUST not inherit the creating administrator's unrestricted permissions.

## Visibility

- `private`: visible only to authorized workspace members and principals.
- `workspace`: visible to authenticated members of the owning workspace.
- `public`: metadata and published versions visible without membership; amendment and context access still require authorization.

Public retrieval through MCP MUST still require caller metadata for analytics. Anonymous web views MUST use channel `public-web` and server-observed request metadata.

# Security

- Session cookies MUST be secure, HTTP-only, same-site appropriate, and domain-scoped.
- State-changing browser requests MUST use CSRF protection.
- OAuth authorization code flow MUST require PKCE S256.
- OAuth codes MUST expire within 5 minutes and be single-use.
- Access tokens MUST expire within 60 minutes.
- Refresh tokens MUST expire within 30 days, rotate on every use, and trigger token-family revocation on reuse.
- API keys MUST be scoped, expirable, revocable, and returned once.
- MCP access tokens MUST be audience-bound to the canonical MCP resource.
- Redirect URIs MUST match exactly and MUST use HTTPS except loopback localhost development URIs.
- Dynamic registration MUST reject private-network, credential-bearing, fragment-containing, wildcard, and non-HTTPS remote redirects.
- OTP endpoints MUST use generic responses to resist user enumeration.
- OTP, invitation, authorization, token, retrieval, and amendment endpoints MUST be rate limited.
- Turnstile MUST protect risky or repeated anonymous OTP sends.
- Bundle parsing MUST defend against zip bombs, traversal, symlinks, duplicate paths, oversized entries, and decompression ratio abuse.
- Markdown rendering MUST sanitize HTML and unsafe URLs.
- Stored scripts MUST never be executed by Skillplane.
- R2 buckets MUST remain private.
- Signed downloads MUST be short-lived and authorization-bound.
- Database, Hyperdrive, R2, Email, OAuth, and Turnstile secrets MUST remain server-only.
- Logs MUST redact tokens, cookies, OTPs, authorization codes, raw email addresses, prompts, and skill content.
- IP addresses MUST be keyed-hashed before durable audit storage.

# Limits

- Skill bundle compressed size: 10 MiB maximum.
- Skill bundle expanded size: 25 MiB maximum.
- File count: 1,000 maximum.
- Individual file: 5 MiB maximum.
- `SKILL.md`: 1 MiB maximum.
- Path length: 240 UTF-8 bytes maximum.
- Context knowledge: 512 KiB maximum.
- Context note body: 256 KiB maximum.
- Contexts per skill: 100.
- Active notes per context: 500.
- Tags per skill or amendment: 30.
- Caller-declaration field: 200 characters.
- Learning `extra`: 32 KiB, depth 8, 200 total keys.
- MCP tool request: 2 MiB except controlled bundle amendment uploads.
- API list limit: default 20, maximum 100.
- OAuth client redirect URIs: 20.
- OAuth scopes per grant: 20.

Limits MUST be enforced before expensive decompression, R2 reads, database writes, or email sends where possible.

# Error codes

The following stable codes MUST exist:

```text
AUTH_REQUIRED
AUTH_INVALID
AUTH_SCOPE_REQUIRED
AUTH_CSRF_INVALID
AUTH_RATE_LIMITED
OAUTH_INVALID_REQUEST
OAUTH_INVALID_CLIENT
OAUTH_INVALID_GRANT
OAUTH_INVALID_SCOPE
OAUTH_INVALID_RESOURCE
OAUTH_REDIRECT_MISMATCH
OAUTH_PKCE_REQUIRED
OAUTH_CONSENT_REQUIRED
OAUTH_TOKEN_REUSE_DETECTED
WORKSPACE_NOT_FOUND
WORKSPACE_FORBIDDEN
MEMBERSHIP_REQUIRED
SKILL_NOT_FOUND
SKILL_SLUG_CONFLICT
SKILL_VERSION_NOT_FOUND
SKILL_VERSION_CONFLICT
SKILL_PUBLISH_CONFLICT
SKILL_BUNDLE_INVALID
SKILL_BUNDLE_TOO_LARGE
SKILL_FILE_NOT_FOUND
SKILL_PATH_INVALID
AMENDMENT_POLICY_DENIED
LEARNING_METADATA_INVALID
CONTEXT_NOT_FOUND
CONTEXT_SLUG_CONFLICT
CONTEXT_REVISION_CONFLICT
NOTE_NOT_FOUND
NOTE_REVISION_CONFLICT
IDEMPOTENCY_KEY_REUSED
CURSOR_INVALID
CURSOR_FILTER_MISMATCH
R2_WRITE_FAILED
R2_READ_FAILED
EMAIL_DELIVERY_FAILED
DATABASE_UNAVAILABLE
INTERNAL_ERROR
```

OAuth endpoint errors MUST additionally conform to OAuth JSON error names and HTTP status rules. MCP tools MUST map domain errors to `isError: true` results with machine-readable JSON content and MUST not leak internals.

# Observability and analytics

## Audit events

Permanent audit events MUST include:

- skill/version creation, approval, rejection, publication, archive, and restore;
- context and note revision creation;
- membership and role changes;
- service-principal and credential lifecycle;
- OAuth consent, grant, revocation, and refresh-token reuse detection;
- amendment policy decisions;
- destructive or security-relevant failures.

Detailed retrieval events MUST be retained for 90 days. Permanent aggregates MUST retain daily counts, unique principal/agent/model dimensions, p50/p95 latency buckets, failures, amendments, approvals, and top contexts.

## UI analytics

Workspace and skill dashboards MUST show:

- retrievals over time;
- unique authenticated principals;
- caller-declared agents and models;
- top skills and contexts;
- amendment and approval rates;
- current-version adoption;
- failures by stable code;
- latency percentiles.

Caller-declared values MUST be labeled as declared metadata. Raw prompts and skill bodies MUST never be copied into analytics.

## Runtime logging

Structured logs MUST include request ID, deployment version, route/tool, outcome, stable error code, duration, and safe resource IDs. Logs MUST omit protected content and credentials.

# User interface

## Design system

The visual system MUST be Linear-inspired without copying proprietary assets:

- compact information density;
- neutral surfaces;
- restrained accent color;
- one-pixel borders;
- 4 px base spacing;
- clear typography hierarchy;
- command-oriented navigation;
- keyboard-visible focus;
- consistent Phosphor icon sizing;
- semantic light and dark themes;
- motion that respects `prefers-reduced-motion`.

Shared tokens and primitives MUST live in `packages/ui`. Feature pages MUST not introduce parallel raw color systems.

## App surfaces

- Authentication and OTP verification.
- Workspace switcher and creation.
- Skills list with filters, full-text search, visibility, state, and usage.
- Skill creation and bundle/Markdown editing.
- Skill detail with Overview, Content, Versions, Contexts, Analytics, Audit, and Settings tabs.
- Side-by-side and unified version diff.
- Candidate review with learning metadata, evidence, validation, caller declaration, and approval controls.
- Context list and context knowledge editor.
- Shared context note list, create, edit, revision history, and archive.
- MCP connection guide, OAuth grants, API credentials, and service principals.
- Member and invitation management.
- Audit explorer and analytics dashboard.

Every surface MUST implement loading, empty, success, validation, authorization, error, and retry states. Destructive operations MUST require confirmation and describe preserved history.

## Landing surfaces

- concise hero explaining skills that improve with controlled learning;
- product workflow showing create, contextualize, retrieve, amend, review, and publish;
- versioning, context, audit, and MCP sections;
- security and deployment posture;
- public skill discovery;
- sign-in and create-account calls to action;
- responsive navigation and footer.

Landing claims MUST correspond to shipped behavior.

## Accessibility

The UI MUST meet WCAG 2.2 AA for color contrast, keyboard access, focus order, labels, errors, dialogs, reduced motion, landmarks, and screen-reader semantics. Automated accessibility tests MUST be supplemented with keyboard and screen-reader smoke checks.

# DataFn integration

DataFn MUST expose typed, tenant-filtered resources for workspace, membership, skill metadata, version metadata, contexts, notes, reviews, and analytics reads. Sensitive OAuth token tables and raw credential material MUST not be exposed through DataFn.

The Hono domain service MUST own workflows that span R2 and Postgres, publication concurrency, OAuth token issuance, invitation delivery, and other multi-step transactions. DataFn MUST not bypass those invariants. The SvelteKit app MAY use DataFn live queries for authorized reads and safe mutations whose invariants are fully captured by DataFn policy.

# SendFn integration

A Cloudflare Email Service adapter MUST implement the SendFn `EmailProvider` contract. The adapter MUST:

- accept an injected Cloudflare email binding;
- support HTML and text;
- report provider message ID and timestamp;
- enforce Cloudflare recipient and payload limits;
- classify retryable versus permanent errors;
- expose health and lifecycle methods without network work at module import;
- avoid logging recipients or bodies;
- support test-only fake bindings.

The adapter SHOULD live in SendFn in the `next` worktree. Before any edit, implementation MUST create a project-local Superfunctions change log and re-check the dirty worktree. If the relevant export files still contain overlapping uncommitted changes, implementation MUST stop and request user direction.

Skillplane MUST use SendFn to adapt AuthFn OTP delivery. It MUST not call the Cloudflare binding directly from AuthFn routes.

# R2 storage

The R2 object key MUST be content-addressed:

```text
workspaces/{workspaceId}/skills/{skillId}/bundles/sha256/{digest}.zip
```

Database records MUST store the key, digest, byte size, and file manifest. R2 custom metadata MAY store non-sensitive digest and media type only. Access MUST go through authorized Workers; the bucket MUST not be public.

# Database and migrations

- Local Postgres MUST run in Docker with a named volume and health check.
- Production Postgres MUST run on Railway.
- Workers MUST connect to production through Hyperdrive.
- Local application code MUST connect through `DATABASE_URL`.
- Production application code MUST use the Hyperdrive binding connection string.
- Migrations MUST run directly against local or Railway Postgres, never through Hyperdrive caching.
- Schema migration files MUST be committed and immutable after release.
- Migrations MUST support forward application and documented backup/restore; destructive migrations require an explicit data migration and rollback plan.
- Hyperdrive query caching MUST be disabled for authorization, audit, version pointers, and writes; only explicitly safe public metadata reads MAY be cached.

# Performance and caching

- Public landing assets MUST use immutable cache headers.
- Public skill metadata MAY be cached by version digest.
- Private skill and authorization responses MUST use `private, no-store`.
- R2 bundles MAY be cached only by immutable digest after authorization.
- Current-version pointers MUST not be cached across mutations without explicit invalidation.
- Database indexes MUST cover tenant, slug, skill/revision, context/revision, audit time, and full-text search paths.
- Analytics aggregation MUST run in bounded batches and be idempotent.

# Compatibility and versioning

- HTTP endpoints are versioned under `/api/v1`.
- MCP tool names and required input properties are stable within a major release.
- New optional response fields MAY be added.
- Required input changes, changed semantics, or removed fields require a major API version.
- Skill bundles use a manifest `formatVersion`, initially `1`.
- OAuth metadata and behavior MUST track the stable MCP authorization specification selected for the release.
- Superfunctions dependencies MUST be locked to exact local revisions or released package versions; floating branches are forbidden in production lockfiles.
- The deployment record MUST capture application commit, package lock digest, migration version, Worker versions, Hyperdrive binding ID, and R2 bucket name without recording secrets.

# Failure and recovery

- Database unavailability MUST fail closed for private authorization and mutations.
- R2 read failure MUST return `R2_READ_FAILED`; the system MUST not substitute stale or different content.
- Email failure MUST not report an OTP as sent; AuthFn challenge state MUST be safe to retry.
- OAuth token-family reuse MUST revoke the family and emit a permanent security event.
- An orphan R2 bundle MUST be safe to delete only when no version record references its digest.
- A failed analytics write MUST not fail an otherwise successful retrieval; it MUST enqueue or record a bounded retry signal without duplicating events.
- Audit failure for a security-sensitive mutation MUST fail the mutation before commit or use the same Postgres transaction.
- Detailed retrieval-audit failure MUST fail closed for private skill content because retrieval attribution is a product invariant.

# Engineering evidence

- `.conduct/ledger.md` MUST be append-only.
- Every phase MUST add an engineering log and link verification outputs.
- UI phases MUST add screenshots covering specified states.
- Decisions that alter data, security, protocol, or deployment semantics MUST receive a decision record.
- Any Superfunctions edit MUST receive a dedicated log under `.conduct/logs/superfunctions/`.
- Phase completion MUST include a report under the spec bundle's `phase-reports/`.

# Undefined / explicitly user-deferred only

The following are explicitly outside the accepted scope:

- billing and subscription enforcement;
- commercial marketplace curation and payouts;
- semantic/vector search;
- execution of skill scripts by Skillplane;
- private per-agent context notes;
- inline collaborative comments;
- native mobile applications;
- offline mutation support;
- multi-region Postgres writes.

Everything else in the intent inventory is required.
