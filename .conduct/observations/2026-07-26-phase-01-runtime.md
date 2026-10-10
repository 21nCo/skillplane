# PHASE_01 runtime observations

- Timestamp: 2026-07-26T04:57:48Z
- Surface: application Worker root and health API
- Runtime: local Wrangler Worker backed by Docker Postgres and Wrangler R2

## Behavioral observations

1. `GET /api/v1/health/live` returned `200` with service identity,
   request ID, and an ISO timestamp.
2. `GET /api/v1/health/ready` returned `200` with `CONFIG_VALID`,
   `POSTGRES_READY`, and `R2_READY`; no connection details or secrets were
   returned.
3. The application root rendered product identity and the current dependency
   state rather than a simulated dashboard.
4. The 1280 by 720 viewport showed the complete headline and runtime card
   without clipping or horizontal overflow.
5. The 390 by 844 viewport reflowed the heading, copy, and dependency rows
   without truncating status codes or the request ID.
6. The page retained its semantic `main`, labelled regions, heading hierarchy,
   and home link during client hydration.
7. The first visual pass found a missing favicon request. Both SvelteKit
   applications now declare and serve an SVG favicon; the follow-up request
   returned `200 image/svg+xml`.
8. Port `5173` was already owned by an unrelated local development server, so
   the Skillplane Worker was verified on deterministic alternate port `5174`
   without terminating the existing process.

## Screenshot evidence

- Wide ready state:
  `.conduct/screenshots/phase-01-app-root-ready-1280x720-dark.jpg`
- Narrow ready state:
  `.conduct/screenshots/phase-01-app-root-ready-390x844-dark.jpg`

## Persistence observation

The database container was stopped with `pnpm db:down`, the named volume
`skillplane_postgres_data` remained present, and `pnpm db:up` reused it. After
restart, `pnpm services:wait` reported Postgres 17.10 healthy and the Worker
readiness endpoint again returned both `POSTGRES_READY` and `R2_READY`.
