# PHASE_06 — Design system and authenticated application shell

## Phase goal

Build the accessible Linear-inspired design system and complete authenticated navigation shell used by every product workflow.

## In scope

- Tailwind semantic tokens and themes.
- Phosphor icon conventions.
- Core controls, navigation, dialogs, tables, forms, feedback, command palette, and responsive shell.
- Authenticated route guards and workspace switcher integration.
- Storybook or equivalent component workbench.

## Out of scope

- Skill feature pages.
- Analytics charts.
- Landing content.

## Deliverables

- `packages/ui/src/styles/tokens.css`
- `packages/ui/src/styles/tailwind.css`
- `packages/ui/src/components/Button.svelte`
- `packages/ui/src/components/IconButton.svelte`
- `packages/ui/src/components/Input.svelte`
- `packages/ui/src/components/Textarea.svelte`
- `packages/ui/src/components/Select.svelte`
- `packages/ui/src/components/Dialog.svelte`
- `packages/ui/src/components/Dropdown.svelte`
- `packages/ui/src/components/DataTable.svelte`
- `packages/ui/src/components/Tabs.svelte`
- `packages/ui/src/components/Badge.svelte`
- `packages/ui/src/components/Toast.svelte`
- `packages/ui/src/components/EmptyState.svelte`
- `packages/ui/src/components/ErrorState.svelte`
- `packages/ui/src/components/Skeleton.svelte`
- `packages/ui/src/components/CommandMenu.svelte`
- `packages/ui/src/index.ts`
- `app/src/lib/layout/AppShell.svelte`
- `app/src/lib/layout/Sidebar.svelte`
- `app/src/lib/layout/Topbar.svelte`
- `app/src/lib/layout/WorkspaceSwitcher.svelte`
- `app/src/routes/(app)/+layout.server.ts`
- component workbench configuration and accessibility tests
- engineering log, screenshots, phase report, and ledger append

## Requirements covered

- `UI-001`
- `UI-004`
- `UI-005`
- `PROJ-002`
- `QA-001`
- `QA-004`

## Implementation tasks

1. Define semantic color, typography, spacing, radius, shadow, motion, density, and focus tokens.
2. Implement light and dark themes without raw feature color literals.
3. Standardize Phosphor icon sizes and accessible labels.
4. Implement controls with keyboard, screen-reader, loading, disabled, validation, and reduced-motion behavior.
5. Implement responsive authenticated shell and command menu.
6. Integrate route guards, workspace switching, account menu, and sign-out.
7. Add component interaction, accessibility, and visual regression coverage.
8. Capture wide/narrow and light/dark evidence.

## Verification steps

```bash
pnpm test:unit --filter @skillplane/ui
pnpm test:a11y --filter @skillplane/ui
pnpm test:visual --filter @skillplane/ui
pnpm lint:design-system
pnpm build --filter app
```

Expected outcomes:

- Controls pass keyboard and accessibility tests.
- No unapproved icon or raw color imports exist.
- Shell works at 390, 768, and 1440 pixel widths.
- Theme and reduced-motion screenshots are recorded.

## Stop condition

Report token inventory, accessibility results, visual diffs, and shell screenshots before `PHASE_07`.
