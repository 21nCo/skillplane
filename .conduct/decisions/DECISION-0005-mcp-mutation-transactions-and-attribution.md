# DECISION-0005 — MCP mutation transactions and attribution

- Date: `2026-07-26`
- Status: accepted
- Scope: PHASE_12 MCP amendments and context mutations

## Decision

MCP mutation tools use the same `AmendmentService`,
`ContextKnowledgeService`, and `ContextNoteService` operations as the
authenticated application. Successful mutation audit is inserted by those
domain services on the same Postgres client and inside the same transaction as
the durable candidate or revision and its idempotency completion.

MCP passes a typed audit context containing:

- stable credential kind and ID;
- OAuth client ID when applicable;
- the complete caller-declared agent, model, client, run, session, and
  conversation fields.

The authenticated actor and optional delegated user remain derived from the
credential. Caller data never selects the principal. Organization service
principals may have no delegated user; migration
`0013_organization_agent_attribution.sql` keeps agent/model paired while
allowing that authenticated user field to remain null.

## Consequences

- An audit insert failure rolls back the candidate/revision and idempotency
  completion.
- Failed amendment uploads are removed from R2 when no database version
  references them.
- Exact retries return the original resource without adding another immutable
  revision or amendment-created event.
- Changed-payload key reuse returns `IDEMPOTENCY_KEY_REUSED`.
- Denied or failed tool attempts use the existing safe MCP audit writer and do
  not count as successful mutations.
- Application writes continue to use the same domain operations and receive
  app-channel mutation audit without MCP caller metadata.

## Rejected alternatives

- Auditing successful mutations after the domain service returns: a database
  audit failure could leave an acknowledged unaudited mutation.
- Duplicating amendment/context semantics in the MCP Worker: policy,
  concurrency, validation, and idempotency could diverge from the app.
- Fabricating a human user for organization service principals: this would
  collapse authenticated and delegated identity and violate the audit model.
