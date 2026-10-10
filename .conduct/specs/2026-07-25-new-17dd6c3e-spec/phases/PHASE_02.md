# PHASE_02 — Postgres, DataFn, and Hono data foundation

## Phase goal

Implement the authoritative Postgres schema, migrations, DataFn application model, Hono envelopes, and tenant-safe request context.

## In scope

- Core database schema and migrations.
- AuthFn schema integration entrypoint.
- DataFn schema/server/client composition.
- Hono request IDs, envelopes, error mapping, security headers, and transaction context.
- Seed and reset tools for tests only.

## Out of scope

- OTP delivery.
- Skill R2 bundles.
- OAuth authorization server.
- Feature UI.

## Deliverables

- `packages/db/src/schema/*.ts`
- `packages/db/src/client.ts`
- `packages/db/src/migrate.ts`
- `packages/db/src/transactions.ts`
- `packages/db/src/index.ts`
- `packages/db/drizzle.config.ts`
- `packages/db/migrations/*`
- `packages/domain/src/principal.ts`
- `packages/domain/src/authorization.ts`
- `packages/domain/src/errors.ts`
- `packages/api/src/envelopes.ts`
- `packages/api/src/errors.ts`
- `packages/api/src/middleware/request-id.ts`
- `packages/api/src/middleware/security.ts`
- `packages/api/src/middleware/context.ts`
- `packages/api/src/app.ts`
- `packages/datafn/src/schema.ts`
- `packages/datafn/src/server.ts`
- `packages/datafn/src/client.ts`
- `packages/testing/src/postgres.ts`
- `packages/testing/src/fixtures.ts`
- integration tests beside each package
- engineering log, phase report, and ledger append

## Requirements covered

- `DATA-001`
- `DATA-002`
- `DATA-003`
- `AUTH-004`
- `OPS-004`
- `OPS-006`
- `QA-001`
- `QA-003`
- `QA-004`

## Implementation tasks

1. Define all domain tables, foreign keys, unique constraints, retention classes, and indexes from `SPEC.md`.
2. Integrate AuthFn and future plugin schema generation without duplicating tables.
3. Create forward-only migration files and schema verification.
4. Implement direct local `DATABASE_URL` and production Hyperdrive client factories with no placeholder production ID.
5. Define authenticated principal and authorization context types.
6. Implement canonical success/error envelopes and stable errors.
7. Compose DataFn resources with tenant-safe policies and exclude secret tables.
8. Add Hono middleware in tested order.
9. Add database reset/fixtures only in `packages/testing`.
10. Validate query plans for tenant/slug/version/context paths.

## Verification steps

```bash
pnpm db:reset:test
pnpm db:migrate
pnpm db:verify
pnpm test:unit --filter @skillplane/db --filter @skillplane/domain
pnpm test:integration --filter @skillplane/datafn --filter @skillplane/api
pnpm test:security --filter tenant-foundation
pnpm typecheck
```

Expected outcomes:

- Fresh and repeated migrations succeed.
- Foreign keys and tenant uniqueness reject invalid records.
- Cross-workspace DataFn queries return no protected data.
- Hono errors match canonical envelopes.
- Secret tables are absent from DataFn introspection.

## Stop condition

Report migration ID, schema inventory, query-plan evidence, and tenant-isolation results before `PHASE_03`.
