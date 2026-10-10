# PHASE_07 engineering log

- Started: `2026-07-26T08:36:00Z`
- Completed: `2026-07-26T09:34:02Z`
- Status: `COMPLETE — PASS`
- Scope: complete browser skill management, immutable version inspection,
  review/publication, visibility and archive lifecycle, authorization-safe
  search/listing, public sharing, and objective browser/a11y/visual evidence.

## Implemented

1. Added an authorized skill inventory with full-text search, visibility and
   lifecycle filters, signed cursor pagination, current-version metadata,
   retryable errors, and archived-skill discovery.
2. Added direct Markdown authoring and ZIP bundle upload. Both paths build or
   validate the portable bundle locally and submit the same production create
   contract.
3. Added overview, safe Markdown preview, exact-version file browsing,
   digest/manifest display, text/image/binary handling, file download, and
   bundle-derived candidate editing.
4. Added immutable version history, exact-version routes, provenance, unified
   and side-by-side text diffs, bounded binary/truncated states, and
   keyboard-scrollable source regions.
5. Added candidate review with admin/owner publication and rejection controls,
   semantic bump presentation, idempotency keys, typed stale-base conflict
   feedback, and published-state refresh.
6. Added public/private visibility, anonymous public retrieval, settings
   summaries, destructive archive confirmation, archived list filtering, and
   restore.
7. Enforced role behavior in both layers: the viewer UI omits or disables
   mutations, while direct viewer mutation requests are rejected by the Hono
   authorization middleware/domain services.
8. Extended the skill API with filtered cursor listing, slug lookup, public
   slug lookup, exact version/file/bundle retrieval, and public file access
   constrained to current published public versions.
9. Added a shared typed client/store and explicit loading, empty, error/retry,
   success, conflict, authorization, validation, and confirmation states.
10. Added focused unit, API integration, Playwright lifecycle, WCAG matrix,
    deterministic visual-regression, and production-build coverage.

## Persisted browser workflow

The browser suite uses the actual SvelteKit UI, Hono application, AuthFn
session/CSRF contracts, local Postgres, domain services, and the object-storage
interface used by the Cloudflare R2 binding.

1. A forced first-list `503 R2_READ_FAILED` displayed an actionable retry
   state and recovered without reloading the application.
2. Required create fields blocked submission. Markdown authoring then created
   a public skill at immutable revision 1 / semantic version `1.0.0`.
3. Reload and direct navigation returned the same persisted skill and current
   version.
4. Editing `SKILL.md` created pending revision 2; its exact-version route
   showed the real diff and remained present after reload.
5. Owner publication assigned `1.0.1`; both unified and side-by-side history
   comparisons showed the changed instructions.
6. Two candidates sharing one base were created. Publishing one advanced the
   skill; publishing the other displayed a typed conflict and did not mutate
   that candidate.
7. Private visibility returned public `404`; switching back to public exposed
   the newest published instructions on the anonymous share route.
8. Archive removed the skill from the default list and public route while
   retaining it in the archived filter. Restore persisted after reload and
   made the public route available again.
9. A viewer saw no create/edit/archive action, saw disabled settings, received
   direct mutation `403 FORBIDDEN`, and retained read access.
10. The overview remained usable at `390x844` in the light theme.

## Accessibility and visual evidence

- Axe scanned list, create, overview, content, versions, exact-version,
  settings, and public routes at `390x844`, `768x1024`, and `1440x900` in dark
  and light themes with zero violations.
- The a11y workflow also verifies dialog focus, Escape close, keyboard
  navigation, named scroll regions, and absence of page-level overflow.
- Nine production-page goldens pass with disabled animation and exact
  comparison.
- Ten narrative workflow screenshots record retry, validation, creation,
  exact diff, conflict, public sharing, destructive confirmation, archived
  state, viewer authorization, and mobile layout.
- Manual visual observations are recorded in
  `.conduct/observations/2026-07-26-phase-07-skill-management.md`.

## Defects found and closed

- Public file reads initially required a workspace header when a signed-in
  browser followed the anonymous share route. Public GET authorization now
  correctly bypasses workspace membership only for the constrained public
  endpoint; the domain still requires a public, active skill and its current
  published version.
- The original route data exposed only an unfiltered first page. Signed,
  canonical cursors and authorization-safe filters now back the UI controls.
- Markdown preview needed explicit sanitization. The renderer now removes
  dangerous URLs, raw HTML, event handlers, and unsafe link behavior, with
  focused XSS tests.
- Focusable source/diff/manifest scroll regions raised compiler accessibility
  warnings. Each region now has an accessible name and a documented,
  intentional keyboard-focus exception.
- Strict TypeScript/ESLint identified unstable reactive maps, unsafe template
  interpolation, navigation-rule false positives around encoded queries, and
  optional-state branches. These are resolved; lint and all 23 typecheck tasks
  pass without warnings.

## Final verification

```text
pnpm test:unit --filter app -- skills
PASS — 3/3

pnpm test:integration --filter skill-api
PASS — 1/1 end-to-end API scenario

pnpm test:a11y --filter skill-pages
PASS — 1/1 matrix scenario, 48 route/theme/viewport combinations plus dialog

pnpm test:e2e --grep @skills
PASS — 2/2 persisted browser workflows

pnpm test:visual --filter skill-pages
PASS — 1/1 suite, 9/9 page goldens

pnpm lint
PASS

pnpm typecheck
PASS — 23/23 tasks, zero Svelte warnings

pnpm format:check
PASS

pnpm boundaries:verify
PASS — WORKSPACE_BOUNDARIES_VALID

pnpm lint:design-system
PASS — DESIGN_SYSTEM_POLICY_PASSED

pnpm client-secrets:verify
PASS — CLIENT_BUNDLES_SECRET_FREE

pnpm build
PASS — 13/13 package builds, including Cloudflare Worker dry-run
```

## External boundaries

No Superfunctions worktree or source file was modified in PHASE_07.
