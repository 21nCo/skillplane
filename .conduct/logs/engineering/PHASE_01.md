# Engineering log: PHASE_01 monorepo and local runtime foundation

- Timestamp: 2026-07-26T04:57:48Z
- Operation: monorepo, deployable surfaces, strict configuration, and local
  Postgres/R2 runtime
- Result: complete

## Scope completed

1. Established the pnpm/Turborepo graph for `app/`, `landing/`, `mcp/`, and
   shared packages with a frozen lockfile and exact runtime files.
2. Implemented independently deployable SvelteKit Cloudflare Workers for the
   application and landing surfaces.
3. Implemented the independent Hono MCP Worker and the shared canonical Hono
   application composition root.
4. Added real liveness and readiness endpoints with request IDs, secure
   headers, redacted diagnostics, and dependency timing.
5. Added strict local/production configuration parsing and rejection of
   missing R2, memory Postgres, capture email, and direct production database
   connections.
6. Added Docker Postgres lifecycle scripts with a pinned digest, generated
   non-default credentials, a named volume, a health check, and deterministic
   port behavior.
7. Added persistent local Wrangler R2 bindings and actual R2 readiness access.
8. Added root formatting, lint, typecheck, unit, build, dry-run deployment,
   workspace-boundary, conduct, and client-secret gates.
9. Added real product/runtime roots, error boundaries, responsive states, and
   application favicons.

## Runtime evidence

| Item | Verified value |
|---|---|
| Node | `v20.20.0` |
| pnpm | `11.9.0` |
| Turbo | `2.10.7` |
| SvelteKit | `2.70.1` |
| Svelte | `5.56.8` |
| Hono | `4.12.32` |
| Wrangler | `4.86.0` |
| Docker client/engine | `29.6.1` / `29.6.1` |
| Postgres | `17.10`, server version `170010` |
| Postgres port | `5432` |
| Postgres volume | `skillplane_postgres_data` |
| Worker verification port | `5174` |
| Worker compatibility date | `2026-05-03` |

The Postgres image is pinned to:

```text
postgres:17-alpine@sha256:742f40ea20b9ff2ff31db5458d127452988a2164df9e17441e191f3b72252193
```

## Behavioral evidence

- Cold start: `pnpm db:up` created a healthy named container and named volume.
- Persisted restart: `pnpm db:down` preserved the volume; the next
  `pnpm db:up` and `pnpm services:wait` returned healthy.
- Liveness returned `200` without querying dependencies.
- Readiness returned `200` only after real Postgres and R2 operations passed.
- Readiness response codes were `CONFIG_VALID`, `POSTGRES_READY`, and
  `R2_READY`; credentials were absent.
- The app root and SVG favicon returned `200` through the Cloudflare Worker
  runtime.
- The MCP dry-run reported an 822.85 KiB upload before gzip.
- Application and landing Cloudflare worker entrypoints were generated.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm db:up
pnpm services:wait
pnpm test:unit --filter @skillplane/config --filter @skillplane/api
pnpm typecheck --force
pnpm test:unit --force
pnpm format:check
pnpm lint
pnpm build --force
pnpm deploy:check --force
pnpm conduct:verify
pnpm boundaries:verify
pnpm client-secrets:verify
curl -fsS http://127.0.0.1:5174/api/v1/health/live
curl -fsS http://127.0.0.1:5174/api/v1/health/ready
curl -fsS http://127.0.0.1:5174/favicon.svg
```

Results:

- frozen install: PASS across 7 workspace projects;
- focused unit tests: PASS, 12 tests;
- complete unit suite: PASS, 13 tests;
- uncached typecheck: PASS, 8 tasks;
- uncached build: PASS, 6 tasks;
- uncached deployment dry-run: PASS, 9 tasks;
- formatting, lint, conduct, boundaries, and secret scan: PASS;
- live Worker probes before and after database restart: PASS.

## Defects found and closed

1. Wrangler `4.86.0` rejected a later compatibility date. All Workers now use
   the newest compatibility date supported by the pinned runtime,
   `2026-05-03`.
2. An uncached TypeScript 6 check found that the MCP export inferred a private
   API environment. `ApiEnvironment` and `ApiVariables` are now explicit
   public contracts, and the forced typecheck passes.
3. Browser inspection found a missing favicon. Both web applications now ship
   and declare a real SVG favicon.

## UI evidence

- `.conduct/observations/2026-07-26-phase-01-runtime.md`
- `.conduct/screenshots/phase-01-app-root-ready-1280x720-dark.jpg`
- `.conduct/screenshots/phase-01-app-root-ready-390x844-dark.jpg`

## Next safe action

Begin PHASE_02 database migrations, DataFn composition, shared HTTP envelopes,
and authorization-aware integration without modifying the external
Superfunctions worktrees.
