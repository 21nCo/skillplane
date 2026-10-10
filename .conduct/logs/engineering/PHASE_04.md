# PHASE_04 engineering log

- Started: `2026-07-26T06:30:00Z`
- Last checkpoint: `2026-07-26T07:12:34Z`
- Status: `COMPLETE — PASS`
- Scope: personal and organization workspaces, membership roles, invitations,
  service principals, API/DataFn/UI integration, and persistence E2E.

## Authoritative scope correction

PHASE_04 is the tenancy phase. R2 bundle persistence belongs to PHASE_05 and
was not pulled forward.

## Implemented at this checkpoint

1. Added forward migration `0006_tenancy_credentials.sql`.
2. Added workspace kind, creator, and unique personal-owner identity.
3. Replaced plaintext invitation email persistence with email-hash and
   ciphertext fields, plus accepted-user attribution.
4. Added service-principal role, creator, optional delegated user, expiry, and
   credential-version fields.
5. Added the canonical `skills:amend` service scope while retaining existing
   internal write scopes.
6. Added production domain validation for workspace names/slugs, membership
   hierarchy/final-owner protection, invitation lifecycle, and service
   principal scopes/status.
7. Updated service-principal authorization to require both role capability and
   explicit scope.
8. Added 10 focused tenancy tests alongside the existing role-matrix tests.

## Verification at this checkpoint

```text
pnpm db:migrate                            PASS; migration 0006 applied
pnpm db:verify                             PASS; 21 tables, 6 migrations
pnpm --filter @skillplane/db typecheck     PASS
pnpm --filter @skillplane/domain typecheck PASS
pnpm --filter @skillplane/domain test:unit PASS; 11/11
pnpm format:check                          PASS
```

## Defect found and closed

The first migration draft combined `DROP CONSTRAINT` and `RENAME COLUMN` in one
Postgres `ALTER TABLE` statement. Postgres rejected the syntax and rolled the
entire migration transaction back. The operations are now separate statements;
the forward migration applies cleanly and its hash is recorded.

## Remaining phase work

- transactional personal/org workspace services and AuthFn bootstrap;
- membership mutations and final-owner concurrency;
- invitation encryption, delivery, acceptance, revocation, and rate limiting;
- service credential issuance, authentication, rotation, and revocation;
- API/DataFn composition and tenancy security matrices;
- workspace/settings/invitation UI with complete states;
- Playwright reload, authorization, accessibility, and screenshot evidence;
- exact phase gates and immutable completion report.

## 2026-07-26T07:02:10Z implementation checkpoint

The complete tenancy slice is now implemented and the phase is entering its
final verification matrix.

### Backend and security

1. Authenticated sessions transactionally and idempotently bootstrap one
   personal workspace under a per-user Postgres advisory lock.
2. Organization creation, settings, membership listing, hierarchy changes,
   removal, leave, and final-owner protection are implemented as real Hono
   routes.
3. Final-owner mutations lock the workspace membership set; a two-owner
   concurrent removal test proves exactly one request succeeds.
4. Invitation recipients are normalized, HMAC-indexed, and AES-GCM encrypted.
   Raw tokens are SHA-256 hashed, expire after seven days, accept once, require
   the authenticated recipient identity, and can be revoked.
5. Migration `0007_invitation_concurrency.sql` adds an active-recipient partial
   unique index. A concurrent test proves only one invitation and one SendFn
   delivery occur.
6. Invitation tokens are normalized out of API rate-limit keys. Cookie
   mutations require a matching AuthFn CSRF token, including when an attacker
   supplies an unrelated Authorization header.
7. Service credentials are high-entropy, displayed once, hashed at rest,
   explicitly role-and-scope constrained, expirable, rotatable, and immediately
   revocable. Rotation invalidates the prior secret in the next request.
8. Service authentication derives the principal from the credential; delegated
   user identity remains a separate optional field.
9. DataFn workspaces expose personal/organization kind while secret-bearing
   invitation and credential tables remain outside the read model.

### Product surfaces

- Added the authenticated Svelte application shell with workspace switching,
  persisted active selection, responsive navigation, sign-out, and light/dark
  themes.
- Added complete workspace create/update, member/invitation, service-agent, and
  invitation-acceptance pages.
- Added loading, empty, success, validation, forbidden, retry, one-time secret,
  and destructive-confirmation states.
- Service secrets live only in transient component state; Playwright verifies
  they never enter localStorage or sessionStorage and disappear after reload.
- All icons are Phosphor components. Svelte accessibility/type diagnostics pass
  with zero warnings.

### Verification so far

```text
pnpm db:migrate                         PASS; migration 0007 applied
pnpm db:verify                          PASS; 21 tables, 7 migrations
pnpm --filter @skillplane/db typecheck  PASS
pnpm --filter @skillplane/api typecheck PASS
pnpm --filter @skillplane/app typecheck PASS; 0 errors, 0 warnings
pnpm test:integration --filter tenancy  PASS; 11 tests before final additions
pnpm test:security --filter tenancy     PASS; 6 tests before final additions
pnpm test:e2e --grep @workspace         PASS; 1 real browser workflow
```

### Defects found and closed

- Fixture cleanup initially deleted only the seeded organization and then
  violated the new personal-owner foreign key. Cleanup now removes every
  fixture-created/personal workspace before deleting the AuthFn user.
- An arbitrary Authorization header could have skipped API CSRF verification
  if a cookie session remained authenticated. CSRF is now skipped only for a
  bearer request without the session cookie or an authenticated service
  principal.
- Raw invitation tokens would have entered rate-limit bucket input through the
  request path. Those paths now use fixed route templates before hashing.
- The first mobile screenshot captured an entering drawer. The assertion now
  requires 90 percent viewport intersection before evidence capture.

### Evidence

- `.conduct/screenshots/phase-04/workspaces-desktop-dark.png`
- `.conduct/screenshots/phase-04/workspaces-desktop-light.png`
- `.conduct/screenshots/phase-04/members-pending-invitation-dark.png`
- `.conduct/screenshots/phase-04/invitation-ready-dark.png`
- `.conduct/screenshots/phase-04/agent-credentials-desktop-dark.png`
- `.conduct/screenshots/phase-04/workspace-mobile-navigation-dark.png`

### Remaining

- Repeat the exact five phase commands after the final scope/role additions.
- Run repository-wide type, lint, format, build, boundary, secret, database,
  deploy-dry-run, and conduct gates.
- Write the immutable PHASE_04 report and append the two execution logs.

## 2026-07-26T07:12:34Z completion

PHASE_04 is complete. The exact phase commands and the repository-wide release
matrix pass from the final source state.

### Role matrix

| Capability | Viewer | Editor | Admin | Owner | Service credential |
|---|---:|---:|---:|---:|---|
| Workspace, members, skills, contexts, analytics read | Yes | Yes | Yes | Yes | Role plus matching scope |
| Skills and contexts write | No | Yes | Yes | Yes | Role plus matching scope |
| Workspace settings, member, invitation, and service management | No | No | Yes | Yes | Role plus matching scope where defined |
| Audit read | No | No | Yes | Yes | Role plus `audit:read` |
| Workspace delete / final ownership control | No | No | No | Yes | Never |

The final-owner invariant is transactionally enforced. Service access is the
intersection of its role and explicit scopes; a role alone never grants a
service capability.

### Invitation delivery and lifecycle evidence

- Integration and browser flows captured real SendFn transactions through the
  production composition boundary using the test provider.
- Concurrent requests for one normalized recipient created one active
  invitation and one SendFn transaction.
- The matching AuthFn user accepted the invitation exactly once; reload showed
  the terminal used state.
- Postgres retained only a versioned AES-GCM email envelope, HMAC lookup, and
  token digest. Raw recipient addresses and tokens were absent.

### Credential redaction evidence

- Service secrets are returned only by create/rotate responses and never by
  list responses.
- Postgres stores only a digest; rotation invalidates the old credential and
  revocation invalidates the current credential immediately.
- Playwright verified that no secret entered localStorage or sessionStorage and
  that it disappeared after reload.
- Client-bundle and `.conduct` runtime-secret scans passed.

### Final verification

```text
domain exact gate          PASS; 5 files, 11 tests
tenancy integration        PASS; 2 files, 12 tests
tenancy security           PASS; DataFn 1 + API 6 tests
workspace E2E              PASS; 1 test in 20.4 seconds
typecheck                  PASS; 19 tasks, Svelte 0 warnings
lint / format              PASS
build                      PASS; 11 tasks
deploy dry-run             PASS; 14 tasks
database                   PASS; 21 tables, 7 migrations
boundaries / client secret PASS
conduct / runtime secret   PASS
```

### Completion evidence

- Immutable report:
  `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_04-2026-07-26-db09764a-report.md`
- Stable completion record:
  `.conduct/specs/2026-07-25-new-17dd6c3e-spec/phase-reports/PHASE_04.md`
- Runtime observations:
  `.conduct/observations/2026-07-26-phase-04-tenancy-ui.md`
- Visually inspected screenshots: `.conduct/screenshots/phase-04/`
