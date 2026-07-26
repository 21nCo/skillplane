# PHASE_14 verification evidence

Completed at `2026-07-26T15:02:48Z`.

## Required gates

| Command | Result |
|---|---|
| `pnpm test:unit --filter landing` | PASS — 1 file, 3 tests |
| `pnpm test:integration --filter public-skills` | PASS — 1 file, 4 tests |
| `pnpm test:security --filter public-visibility` | PASS — 1 file, 2 tests |
| `pnpm test:a11y --filter landing` | PASS — 2 tests; home, directory, and detail at 390x844, 768x1024, and 1440x900 in both themes |
| `pnpm test:e2e --grep @landing` | PASS — 8 tests against real Hono, Postgres, and local object storage |
| `pnpm test:crawl` | PASS — 1 crawl/SEO/public-isolation test |
| `pnpm test:visual --filter landing` | PASS — 1 test, 5 exact goldens |

## Public and private isolation

- Anonymous browsing returned only active public skills with current
  published versions.
- Full-text search matched current published instructions after the public
  authorization filter and did not return private/workspace skills, contexts,
  or candidate content.
- Public history returned published versions only and omitted candidate IDs,
  learning metadata, and caller declarations.
- Public detail and history returned non-leaking `404` responses for private
  and workspace skills.
- Changing a public skill to private immediately removed it from origin
  discovery, current detail, history, and digest-file routes.
- Immutable file routes require the exact version ID and bundle digest,
  validate the file from object storage, set a file ETag, and support `304`.
- Malicious Markdown is rendered through the shared sanitized Markdown
  component; active HTML is not trusted.

## Discovery and caching

- Empty-query public browsing uses deterministic ID tie-breaking and signed
  cursors.
- Query, tag, visibility, archive, or scope changes invalidate an existing
  cursor with `CURSOR_FILTER_MISMATCH`.
- Current public discovery/detail/history and SSR pages use immediate
  revalidation.
- Published version-and-digest file responses use one-year immutable caching.
- Private/application responses remain `private, no-store`.
- `pnpm db:verify` selected `skills_public_search_idx` for the public search
  query plan and reported 31 tables and 15 migrations.

## Content and crawl contract

- The content unit suite verifies the shipped Create, Contextualize,
  Retrieve, Amend, Review, and Publish workflow.
- Capabilities map to implemented versioning, contexts, MCP retrieval,
  controlled amendments, caller provenance, and audit.
- Unsupported pricing, purchase, payout, marketplace, and incomplete-product
  claims fail the content contract.
- Home, directory, and public detail resolve with canonical metadata.
- OpenGraph/Twitter metadata and the social card are present.
- `robots.txt` allows public content, disallows `/api/`, and points to the
  canonical sitemap.
- `sitemap.xml` includes home, directory, and every paginated public skill
  while excluding the private fixture.
- Sign-in and create-account CTAs resolve to `app.skillplane.dev`.

## UI and screenshots

Eight manually inspected screenshots are stored in
`.conduct/screenshots/phase-14/`:

| Screenshot | Observation |
|---|---|
| `landing-home-desktop-dark.png` | Complete product workflow, capability, security, audit-event, CTA, and footer composition at 1440 px. |
| `landing-home-mobile-light.png` | Responsive 390 px layout without clipping; compact cards and navigation remain legible. |
| `landing-directory-desktop-light.png` | Public search and skill card hierarchy are clear and production-linked. |
| `landing-skill-tablet-dark.png` | Sanitized instructions, published history, metadata, and MCP connection guidance remain usable at 768 px. |
| `landing-directory-empty-mobile-dark.png` | Search-specific empty state explains the outcome and offers a clear reset. |
| `landing-directory-loading-desktop-light.png` | Search progress text, disabled action, and six content-shaped skeletons are visible. |
| `landing-directory-error-desktop-light.png` | Specific retryable error and Retry action are prominent without losing the search context. |
| `landing-mobile-menu-keyboard-focus.png` | Mobile navigation opens from the keyboard and visibly focuses its first link. |

Automated Axe checks found no selected WCAG 2.0 A/AA, 2.1 AA, or 2.2 AA
violations across the full page/theme/viewport matrix. No tested page had
horizontal overflow.

## Repository gates

| Command | Result |
|---|---|
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS |
| `pnpm lint:design-system` | PASS |
| `pnpm typecheck` | PASS — 29/29 tasks; Svelte 0 errors, 0 warnings |
| `pnpm build` | PASS — 16/16 workspaces |
| `pnpm deploy:check` | PASS — 19/19 tasks; app, landing, and MCP Worker dry-runs |
| `pnpm db:verify` | PASS — 31 tables, 15 migrations, public-search index plan |
| `pnpm boundaries:verify` | PASS — `WORKSPACE_BOUNDARIES_VALID` |
| `pnpm client-secrets:verify` | PASS — `CLIENT_BUNDLES_SECRET_FREE` |

The first landing build identified `_headers` under `static/`, which
`@sveltejs/adapter-cloudflare` rejects. Moving the file to the landing project
root resolved the packaging error, and the final full build and deploy
dry-runs passed. A parallel browser-gate trial also exposed the shared Vite
HMR port and local Wrangler SQLite isolation boundary; those invalid runs
were stopped, and every required browser command passed serially.

No Superfunctions worktree or source file was modified. No production
Cloudflare, Railway, Hyperdrive, R2, DNS, or email state was changed.
