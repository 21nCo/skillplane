# DECISION-0001: Skillplane platform architecture

- Status: accepted
- Date: 2026-07-25

## Decision

Skillplane MUST use:

- a pnpm and Turborepo monorepo;
- SvelteKit for `app/` and `landing/`;
- Tailwind CSS and Phosphor icons through a shared design-system package;
- Hono as the backend HTTP composition layer;
- AuthFn for user sessions, email OTP, API keys, and plugin composition;
- DataFn for typed application data access and synchronization;
- SendFn for OTP delivery through a Cloudflare Email Service adapter;
- Postgres for relational data, with Docker Postgres locally and Railway Postgres in production;
- Cloudflare Hyperdrive between production Workers and Railway;
- Cloudflare R2 for immutable skill bundles;
- a separate Streamable HTTP MCP Worker at `mcp.skillplane.dev`;
- a Skillplane-owned AuthFn OAuth authorization-server plugin rather than a broad AuthFn core modification.

## Rationale

The architecture keeps authoritative metadata and authorization in Postgres, immutable skill artifacts in R2, user authentication in AuthFn, typed data management in DataFn, and agent interoperability in the MCP Worker. The OAuth plugin remains isolated while still using AuthFn's schema and route plugin contracts.

## Consequences

- Production deployment requires a user-supplied Hyperdrive ID and provisioned R2 and Email Service bindings.
- Local development MUST run a real Postgres container and local R2 binding.
- Skillplane MUST not depend on caller-supplied user identity for audit attribution.
- Any SendFn change MUST be narrowly scoped and recorded under `.conduct/logs/superfunctions/`.
- Existing uncommitted changes in external worktrees MUST never be overwritten.
