# PHASE_07 — Skill management application

## Phase goal

Deliver complete browser-based skill creation, content editing, version inspection, diffing, publication, visibility, and lifecycle management.

## In scope

- Skills list/search/filter.
- Create skill from Markdown or bundle.
- Skill overview/content/versions/settings.
- Version and file viewing.
- Side-by-side and unified diff.
- Archive/restore and visibility.
- Complete UI states and persistence assertions.

## Out of scope

- Contexts and notes.
- Agent amendment review.
- Analytics.

## Deliverables

- `app/src/routes/(app)/[workspaceSlug]/skills/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/new/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/+layout.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/content/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/versions/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/versions/[versionId]/+page.svelte`
- `app/src/routes/(app)/[workspaceSlug]/skills/[skillSlug]/settings/+page.svelte`
- `app/src/lib/skills/SkillEditor.svelte`
- `app/src/lib/skills/BundleUploader.svelte`
- `app/src/lib/skills/VersionDiff.svelte`
- `app/src/lib/skills/VersionTimeline.svelte`
- `app/src/lib/skills/SkillState.svelte`
- route loaders/actions and API client modules
- Playwright specs and screenshot evidence
- engineering log, phase report, and ledger append

## Requirements covered

- `TEN-003`
- `SKL-001`
- `SKL-002`
- `SKL-004`
- `SKL-005`
- `SKL-009`
- `SKL-010`
- `UI-002`
- `UI-004`
- `UI-005`
- `QA-002`
- `QA-004`

## Implementation tasks

1. Build authorized skills list with search, filters, pagination, visibility, state, and current version.
2. Build create flow supporting direct `SKILL.md` authoring and validated bundle upload.
3. Implement overview and content browser with safe Markdown rendering.
4. Implement versions timeline, immutable metadata, file manifest, and exact-version links.
5. Implement side-by-side and unified diff with accessible navigation.
6. Implement visibility, amendment policy summary, archive, and restore settings.
7. Ensure role-specific actions are enforced server-side and represented clearly.
8. Cover every loading/empty/error/conflict/confirmation state.
9. Verify creation and lifecycle changes after reload and direct navigation.

## Verification steps

```bash
pnpm test:unit --filter app -- skills
pnpm test:integration --filter skill-api
pnpm test:a11y --filter skill-pages
pnpm test:e2e --grep @skills
pnpm test:visual --filter skill-pages
```

Expected outcomes:

- Editor creates and publishes a real R2-backed skill.
- Viewer cannot mutate through UI or direct request.
- Version and diff pages render exact immutable data.
- Archive/restore and visibility persist after reload.
- Required state screenshots are recorded.

## Stop condition

Report the persisted browser workflow, version/diff evidence, authorization negatives, and screenshot index before `PHASE_08`.
