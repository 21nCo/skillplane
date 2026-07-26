# PHASE_01 — Monorepo and local runtime foundation

## Phase goal

Create the buildable pnpm/Turborepo, SvelteKit/Hono applications, strict configuration, and real local Postgres/R2 runtime.

## In scope

- Root workspace/tooling.
- `app/`, `landing/`, and `mcp/` build targets.
- Shared config and testing packages.
- Docker Postgres with health checks.
- Local Wrangler R2 binding.
- Real liveness and readiness endpoints.

## Out of scope

- Domain tables beyond migration bookkeeping.
- Authentication.
- Skill CRUD.
- Production deployment.

## Deliverables

- `package.json`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `turbo.json`
- `tsconfig.base.json`
- `eslint.config.js`
- `prettier.config.js`
- `docker-compose.yml`
- `.env.example`
- `scripts/db-up.mjs`
- `scripts/db-down.mjs`
- `scripts/wait-for-services.mjs`
- `app/package.json`
- `app/svelte.config.js`
- `app/vite.config.ts`
- `app/src/routes/+layout.svelte`
- `app/src/routes/+page.svelte`
- `app/src/routes/api/[...path]/+server.ts`
- `landing/package.json`
- `landing/svelte.config.js`
- `landing/vite.config.ts`
- `landing/src/routes/+layout.svelte`
- `landing/src/routes/+page.svelte`
- `mcp/package.json`
- `mcp/src/index.ts`
- `mcp/wrangler.jsonc`
- `packages/config/package.json`
- `packages/config/src/index.ts`
- `packages/api/package.json`
- `packages/api/src/health.ts`
- `packages/api/src/index.ts`
- `packages/testing/package.json`
- `packages/testing/src/runtime.ts`
- `.conduct/logs/engineering/PHASE_01.md`
- phase report and ledger append

## Requirements covered

- `PROJ-001`
- `PROJ-002`
- `DATA-001`
- `DATA-003`
- `OPS-001`
- `OPS-004`
- `QA-001`
- `QA-004`

## Implementation tasks

1. Pin supported runtime and package-manager versions and generate a frozen lockfile.
2. Configure SvelteKit Cloudflare adapters for both web applications.
3. Create real application roots with product identity, error boundaries, and health status—not placeholder dashboards.
4. Create the shared Hono app with `/api/v1/health/live` and `/api/v1/health/ready`.
5. Make readiness verify Postgres and R2-local binding without exposing credentials.
6. Configure Docker Postgres with named database/user, named volume, health check, and port preflight.
7. Configure local R2 persistence through Wrangler.
8. Add strict environment parsing for local and production binding modes.
9. Add root formatting, linting, typecheck, build, and focused test commands.

## Verification steps

```bash
pnpm install
pnpm db:up
pnpm services:wait
pnpm test:unit --filter @skillplane/config --filter @skillplane/api
pnpm typecheck
pnpm build
curl -fsS http://127.0.0.1:5173/api/v1/health/live
curl -fsS http://127.0.0.1:5173/api/v1/health/ready
```

Expected outcomes:

- Postgres is healthy on the configured deterministic port.
- Liveness succeeds without dependencies.
- Readiness verifies real local dependencies.
- All three deployable workspaces build.
- Production config tests reject fake/missing bindings.

## Stop condition

Report runtime versions, Docker image/digest, active port, build outputs, and health evidence before `PHASE_02`.
