# DECISION-0004 — MCP read transport, authorization, and integrity boundary

- Date: `2026-07-26`
- Status: accepted
- Scope: `PHASE_11`

## Decision

Skillplane's remote MCP read server uses the stable
`@modelcontextprotocol/sdk@1.29.0` Web Standard Streamable HTTP transport with
one stateless transport/server instance per request. Every endpoint request is
authenticated before protocol handling. Tool input uses strict Zod schemas and
all six tools are explicitly read-only.

The canonical content boundary is:

1. authorize the server-derived principal and requested workspace/skill;
2. resolve one exact immutable database version;
3. read only that version's R2 object key;
4. verify the stored digest;
5. re-canonicalize the archive and compare canonical bytes, bundle digest, and
   the database manifest;
6. persist the attributable audit event before returning content.

Context knowledge and notes remain separate immutable revisions and are
composed into retrieval output only after `contexts:read` authorization. They
do not mutate the selected skill or context revision.

## Rationale

- A stateless transport is safe across Cloudflare isolates and does not depend
  on in-memory session affinity.
- The SDK owns version negotiation and protocol framing while Hono owns
  authentication and deployment routing.
- Authorization before R2 access prevents private object existence and timing
  leaks.
- Exact version and digest verification prevents stale or alternate content
  substitution after a storage failure.
- Server-derived principal identity and caller-declared agent/model metadata
  must remain separate to prevent caller impersonation.
- Durable audit is a disclosure precondition. Daily metrics are a separate
  best-effort write so an analytics failure cannot roll back an already
  durable detailed audit.

## Scope and credential matrix

| Surface | Credential/scope | Additional authorization |
|---|---|---|
| initialize, ping, tools/list | valid OAuth or service credential | none |
| `skills_search` | `skills:read` | workspace membership or public-only results |
| `skill_retrieve` | `skills:read` | membership or published public skill |
| contextual `skill_retrieve` | `skills:read` + `contexts:read` | workspace context access |
| `skill_asset_retrieve` | `skills:read` | exact authorized version |
| `skill_versions_list` | `skills:read` | candidate state requires editor+; service also needs `skills:amend` |
| `context_get` / `context_notes_list` | `contexts:read` | workspace context access |
| signed asset download | `skills:read` | same credential that requested the grant |

## Conformance choice

The phase conformance gate uses the official stable TypeScript SDK client
against the production Hono app and verifies protocol `2025-11-25`,
initialization, initialized notification handling, ping, schema advertisement,
real tool execution, content negotiation, parse errors, version rejection, and
method rejection.

The separately published generic
`@modelcontextprotocol/conformance@0.1.16` runner was inspected. Its active
server scenarios assume generic fixture tool names and its server CLI does not
provide a custom authorization-header option. It is therefore not used to
weaken or bypass Skillplane's protected product endpoint.

Primary references:

- [TypeScript SDK server documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/server.md)
- [Stable v1.29 Web Standard Hono example](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v1.29.0/src/examples/server/honoWebStandardStreamableHttp.ts)
- [MCP conformance framework](https://www.npmjs.com/package/@modelcontextprotocol/conformance)

## Consequences

- The endpoint intentionally returns no `mcp-session-id`; a supplied stale
  session ID is rejected.
- Large assets use five-minute signed grants bound to credential, workspace,
  skill, version, file digest, bundle digest, caller declaration, and parent
  request ID.
- Service principals may be organization-owned without a delegated user.
  Migration `0012_service_principal_audit_identity.sql` preserves paired
  agent/model fields while leaving authenticated `user_id` nullable.
- Mutation tools and persistent session behavior remain outside this phase.
