# PHASE_06 design-system and shell observations

## Token and component contract

`packages/ui/src/styles/tokens.css` is the sole raw-color authority. It defines
26 semantic color roles in each theme, a seven-step type scale, eleven
four-pixel-based spacing steps, five radii, three shadows, two motion
durations, two density modes, and five Phosphor icon sizes.

`packages/ui/src/styles/tailwind.css` maps the semantic roles into Tailwind v4,
provides the global visible-focus contract, and enforces the reduced-motion
fallback. The boundary linter self-tests both negative cases before scanning
`app/src` and `packages/ui/src`.

The 15-component inventory compiles without Svelte warnings. The workbench is a
development/test surface, while every production shell action routes to a real
implemented screen or real AuthFn operation.

## Accessibility matrix

| Theme | 390x844 | 768x1024 | 1440x900 |
|---|---:|---:|---:|
| Dark | 0 Axe violations | 0 Axe violations | 0 Axe violations |
| Light | 0 Axe violations | 0 Axe violations | 0 Axe violations |

The automated scan covers WCAG 2.0 A/AA, WCAG 2.1 AA, and WCAG 2.2 AA tags.
Keyboard observations cover visible focus, dialog opener restoration,
Escape-close behavior, dropdown arrows/Home/End, tab arrows, and command
search/selection. Reduced-motion computed animation duration is at most
`0.01ms`.

## Visual regression inventory

The golden snapshot suite uses Chromium with reduced motion, disabled
animations, and `maxDiffPixels: 0`.

| Snapshot | State |
|---|---|
| `workbench-dark-390.png` | dark compact mobile |
| `workbench-dark-768.png` | dark compact tablet |
| `workbench-dark-1440.png` | dark compact desktop |
| `workbench-light-390.png` | light compact mobile |
| `workbench-light-768.png` | light compact tablet |
| `workbench-light-1440.png` | light compact desktop |
| `dialog-destructive-light-768.png` | light comfortable destructive confirmation |

The snapshots present loading, empty, success, validation, authorization,
error/retry, and destructive-confirmation states. The final comparison found
zero differing pixels across all seven references.

## Authenticated shell observations

The shell was exercised against the existing Hono/AuthFn/Postgres browser
harness rather than a mocked session. SSR blocks anonymous protected content,
the switcher is populated from persisted workspaces, commands perform actual
SvelteKit navigation, and account sign-out revokes the AuthFn session using its
CSRF contract.

At 1440 pixels the shell uses a fixed 15rem workspace rail and sticky top bar.
At 768 pixels the same information hierarchy remains intact. Below 768 pixels,
the sidebar becomes an Escape-dismissable modal drawer with a scrim and inert
page content.

Representative captures:

- `.conduct/screenshots/phase-06/app-shell-1440-dark.png`
- `.conduct/screenshots/phase-06/app-shell-1440-light.png`
- `.conduct/screenshots/phase-06/app-shell-768-dark.png`
- `.conduct/screenshots/phase-06/app-shell-390-drawer-dark.png`

## Manual visual observations

- The dark desktop workbench has a restrained Linear-inspired hierarchy with
  compact controls, semantic state color, and readable dense tables.
- The 390-pixel light workbench stacks controls and states without page-level
  horizontal overflow; the data table scrolls within its own named region.
- The new authorization state is visually distinct and does not imply a retry
  action.
- The authenticated shell retains clear workspace context and primary
  navigation at desktop, while the mobile capture presents a complete drawer
  rather than a clipped desktop rail.

## Scope boundary

PHASE_06 provides the system and shell only. Skill, context, amendment,
analytics, and remaining product pages are deliberately not fabricated here;
their backed implementations belong to later numbered phases.
