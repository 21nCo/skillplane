# Screenshot evidence

UI evidence is stored by phase. Specification generation had no UI.

Every UI implementation phase MUST store representative screenshots here or in a phase-specific subdirectory and link them from the running ledger. Screenshots MUST cover normal, empty, loading, error, narrow viewport, keyboard-focus, and destructive-confirmation states where applicable.

## PHASE_01

- `phase-01-app-root-ready-1280x720-dark.jpg`
- `phase-01-app-root-ready-390x844-dark.jpg`

## PHASE_03

- `phase-03/sign-in-dark.png`
- `phase-03/sign-in-light.png`
- `phase-03/verify-invalid-dark.png`
- `phase-03/verify-expired-light.png`
- `phase-03/verify-rate-limit-light.png`

## PHASE_06

Authenticated application shell:

- `phase-06/app-shell-1440-dark.png`
- `phase-06/app-shell-1440-light.png`
- `phase-06/app-shell-768-dark.png`
- `phase-06/app-shell-390-drawer-dark.png`

Component workbench:

- `phase-06/components/workbench-dark-390.png`
- `phase-06/components/workbench-dark-768.png`
- `phase-06/components/workbench-dark-1440.png`
- `phase-06/components/workbench-light-390.png`
- `phase-06/components/workbench-light-768.png`
- `phase-06/components/workbench-light-1440.png`
- `phase-06/components/dialog-destructive-light-768.png`

The component captures include normal, loading, empty, success, validation,
authorization, retryable error, and destructive-confirmation states.

## PHASE_07

Skill management workflow:

- `phase-07/skills-error-retry-desktop-dark.png`
- `phase-07/skill-create-validation-desktop-dark.png`
- `phase-07/skill-overview-created-desktop-dark.png`
- `phase-07/skill-candidate-exact-diff-desktop-dark.png`
- `phase-07/skill-publish-conflict-desktop-dark.png`
- `phase-07/skill-public-share-desktop-dark.png`
- `phase-07/skill-archive-confirmation-desktop-dark.png`
- `phase-07/skill-archived-settings-desktop-dark.png`
- `phase-07/skill-viewer-authorization-desktop-dark.png`
- `phase-07/skill-overview-mobile-light.png`

These captures record persisted creation, validation, exact-version diff,
stale-base conflict, public sharing, destructive archive confirmation,
archived persistence, viewer authorization, storage error/retry, and the
390-pixel responsive layout. The deterministic visual goldens are stored
beside `packages/testing/e2e/skill-pages.visual.spec.ts`.

## PHASE_14

Landing and public discovery:

- `phase-14/landing-home-desktop-dark.png`
- `phase-14/landing-home-mobile-light.png`
- `phase-14/landing-directory-desktop-light.png`
- `phase-14/landing-skill-tablet-dark.png`
- `phase-14/landing-directory-empty-mobile-dark.png`
- `phase-14/landing-directory-loading-desktop-light.png`
- `phase-14/landing-directory-error-desktop-light.png`
- `phase-14/landing-mobile-menu-keyboard-focus.png`

These captures cover responsive light/dark success layouts, an empty search,
loading skeletons, a retryable server error, and keyboard focus in mobile
navigation. The five deterministic visual goldens are stored beside
`packages/testing/e2e/landing.visual.spec.ts`.

## PHASE_15

- `phase-15/README.md`

The Phase 15 index links the complete zero-diff production golden inventory
and the feature-phase screenshots revalidated by the exact E2E gate. It covers
skill, analytics/audit, landing, component, mobile, error/retry,
keyboard-focus, and destructive-confirmation evidence.
