# PHASE_04 tenancy and UI observations

- Observed: `2026-07-26T07:02:10Z`
- Environment: local Docker Postgres; SvelteKit/Vite browser harness; Chromium.
- Data: isolated generated `example.test` users and workspaces only.

## Runtime observations

1. Eight concurrent authenticated workspace requests produced one personal
   workspace and one owner membership.
2. Two concurrent final-owner removals produced one success and one safe
   `WORKSPACE_FORBIDDEN`; one owner remained.
3. Two concurrent invitations for the same normalized recipient produced one
   row and one SendFn transaction.
4. Invitation persistence contained an AES-GCM envelope, a 64-character HMAC
   email lookup, and a 64-character token digest. It contained neither the raw
   recipient address nor raw token.
5. Mismatched, reused, revoked, and expired invitation states are rejected by
   the same domain lifecycle contract without a membership write.
6. Credential listing and Postgres contain no raw service credential. Rotation
   denies the old secret immediately; revocation denies the replacement on the
   next request.
7. The invitation email browser workflow reached the intended matching AuthFn
   user, accepted once, and showed the used-link state after reload.

## Screenshot inspection

### Desktop workspace, dark and light

- The 1280 by 900 surfaces preserve compact Linear-inspired density, readable
  hierarchy, visible focus-capable controls, and equivalent semantics in both
  themes.
- Active-workspace selection is unambiguous in the switcher, workspace card,
  and settings form.
- No clipping or horizontal overflow was observed.

### Members and invitation

- Pending-invitation state clearly shows recipient, role, expiry, and revoke
  action.
- The public invitation card names the workspace, role, expiry, and explicit
  acceptance action without exposing any token in visible copy.

### Agent credentials

- The persisted list shows role, scopes, credential version, last-use state,
  expiry, rotation, and revocation without rendering secret material.
- The one-time secret dialog was functionally tested but intentionally not
  captured because production secrets are prohibited in screenshots.

### Mobile navigation

- At 390 by 844, the drawer occupies a reachable mobile width, has a close
  control, exposes all phase navigation, preserves the workspace switcher, and
  keeps theme/sign-out controls reachable at the bottom.
- The content remains present behind an obscuring scrim and no desktop-only
  interaction is required.

## Evidence files

- `workspaces-desktop-dark.png`
- `workspaces-desktop-light.png`
- `members-pending-invitation-dark.png`
- `invitation-ready-dark.png`
- `agent-credentials-desktop-dark.png`
- `workspace-mobile-navigation-dark.png`

All files are under `.conduct/screenshots/phase-04/`.
