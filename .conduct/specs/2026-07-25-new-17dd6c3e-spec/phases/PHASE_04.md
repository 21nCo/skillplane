# PHASE_04 — Workspaces, memberships, invitations, and service principals

## Phase goal

Implement personal and organization tenancy with complete role enforcement, invitations, and scoped service credentials.

## In scope

- Personal workspace bootstrap.
- Organization creation and settings.
- Membership role lifecycle.
- Email invitations.
- Service principals and scoped credentials.
- DataFn/API/UI integration.

## Out of scope

- Skill content.
- MCP OAuth grants.
- Detailed audit UI.

## Deliverables

- `packages/domain/src/workspaces.ts`
- `packages/domain/src/memberships.ts`
- `packages/domain/src/invitations.ts`
- `packages/domain/src/service-principals.ts`
- `packages/api/src/routes/workspaces.ts`
- `packages/api/src/routes/invitations.ts`
- `packages/api/src/routes/service-principals.ts`
- `app/src/routes/(app)/+layout.svelte`
- `app/src/routes/(app)/workspaces/+page.svelte`
- `app/src/routes/(app)/settings/members/+page.svelte`
- `app/src/routes/(app)/settings/agents/+page.svelte`
- `app/src/routes/invitations/[token]/+page.svelte`
- supporting Svelte stores/components and tests
- engineering log, screenshots, phase report, and ledger append

## Requirements covered

- `AUTH-004`
- `AUTH-007`
- `TEN-001`
- `TEN-002`
- `UI-002`
- `UI-004`
- `UI-005`
- `QA-002`
- `QA-004`

## Implementation tasks

1. Implement idempotent personal-workspace creation tied to AuthFn user creation/session bootstrap.
2. Implement organization creation, slug constraints, owner assignment, and final-owner invariant.
3. Implement membership list, role change, removal, leave, and authorization matrix.
4. Implement hashed, expiring, revocable, single-use invitations and SendFn delivery.
5. Implement service-principal creation, role/scopes, one-time secret display, expiry, rotation, and revocation.
6. Build workspace switcher and settings surfaces using the shared UI system available at this point.
7. Add tenant isolation, concurrency, invitation, and credential leakage tests.
8. Verify every mutation after reload.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/domain -- workspaces memberships invitations service-principals
pnpm test:integration --filter tenancy
pnpm test:security --filter tenancy
pnpm test:e2e --grep @workspace
pnpm typecheck
```

Expected outcomes:

- Concurrent first login creates one personal workspace.
- Role matrix and final-owner rules hold.
- Invitations accept exactly once.
- Service credential scopes and revocation are immediate.
- UI state persists across reload.

## Stop condition

Report the role matrix results, invitation delivery evidence, service-secret redaction scan, and workspace screenshots before `PHASE_05`.
