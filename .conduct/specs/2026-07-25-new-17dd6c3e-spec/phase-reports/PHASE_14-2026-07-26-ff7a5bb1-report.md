# PHASE_14 completion report

## Metadata

| Field | Value |
|---|---|
| Timestamp | `2026-07-26T15:02:48Z` |
| Agent | `unknown-agent` |
| Model | `GPT-5` |
| Launcher | `Codex Desktop` |
| Workspace | repository root |
| Environment | `Darwin arm64`, shell `zsh`, local Postgres |
| Git | branch `main`; no commits yet; implementation remains uncommitted |

## Phase

`PHASE_14` — Landing site and public skill discovery

## Status

**PASS**

Skillplane now has a production SvelteKit landing site, truthful product
workflow and security content, responsive application navigation, anonymous
authorization-safe public discovery, sanitized published skill detail and
history, explicit immutable/current cache contracts, complete crawl/social
metadata, and real-service browser, accessibility, security, and visual
evidence.

## Requirements summary

Requirements delivered: `TEN-003`, `SKL-010`, `UI-001`, `UI-003`, `UI-004`,
`UI-005`, `OPS-005`, `QA-002`, and `QA-004`.

| Requirement | Status | Acceptance evidence |
|---|---|---|
| `TEN-003` | PASS | Anonymous current/history/file routes expose only active public published versions; private/workspace skills, candidates, contexts, notes, learning metadata, declarations, and audit data are absent; visibility revocation is origin-enforced. |
| `SKL-010` | PASS | Postgres public search filters authorization before ranking, indexes current published instructions and metadata, uses stable ID tie-breaking, and returns signed filter-bound cursors. |
| `UI-001` | PASS | Landing uses shared semantic tokens, compact Tailwind styling, Phosphor icons, persisted light/dark themes, and passes the design-system policy and contrast/accessibility matrix. |
| `UI-003` | PASS | Shipped workflow/capabilities/security claims, app CTAs, discovery, canonical/social metadata, sitemap, and robots all pass; prohibited commerce and incomplete-product claims are unit-guarded. |
| `UI-004` | PASS | Axe and overflow checks pass home/directory/detail at 390, 768, and 1440 px in both themes; skip link, visible focus, mobile keyboard entry, Escape close, and focus restoration pass. |
| `UI-005` | PASS | Public discovery implements loading, empty, success, validation, hidden/not-found, error, and retry states; read-only public workflows have no destructive action requiring confirmation. |
| `OPS-005` | PASS | Current public surfaces revalidate, exact digest files are immutable with ETags/304, private responses remain no-store, and database verification selects the public search index. |
| `QA-002` | PASS | Playwright uses real SvelteKit SSR, Hono, Postgres, domain services, and local object storage; it verifies production-backed discovery/detail/history, failures, privacy, navigation, and SEO. |
| `QA-004` | PASS | Exact commands, audit, decision, verification evidence, eight screenshots, observations, engineering log, ledger append, and unique report are recorded. |

## Public discovery and isolation

- Empty public browsing and search are anonymous and return active public
  skills with current published versions only.
- Full-text ranking uses the public search document after authorization
  filtering; no semantic embeddings were added.
- HMAC cursors bind query, tags, visibility, archive state, and scope, expire,
  and reject changed filters.
- Public history uses the domain service's anonymous published-only path.
- Exact file retrieval verifies public visibility, version ownership, bundle
  digest, normalized path, object bytes, manifest digest, and file digest.
- Public response mappers omit learning metadata, amendment operations, caller
  declaration, policy decision, and creator attribution.
- Direct origin checks prove visibility revocation removes discovery,
  current, history, and digest access immediately.

## Landing and public product surfaces

- Home: production navigation, headline, MCP retrieval demonstration,
  controlled learning loop, workflow, capability grid, security/provenance
  section, audit example, CTA, and footer.
- Directory: SSR initial data plus client search/load-more, URL query
  replacement, signed pagination, and every non-happy state.
- Detail: sanitized current `SKILL.md`, immutable published version history,
  manifest/digest metadata, raw digest link, MCP endpoint, and an explicit
  privacy boundary.
- Navigation: desktop and keyboard-operable mobile variants, skip link, theme
  persistence before paint, and production app CTAs.
- Errors: tailored public 404 and retryable service error behavior without
  protected detail.

## SEO, crawl, and cache results

- Canonical URLs exist for home, directory, and detail.
- OpenGraph/Twitter descriptions and the canonical social card are present.
- `robots.txt` disallows API crawling and links the canonical sitemap.
- The sitemap paginates the complete public directory, includes public detail
  URLs, excludes the private fixture, detects cursor loops, and fails closed
  past its bounded generation limit.
- Current directory/detail/history/HTML use
  `public, max-age=0, must-revalidate`.
- Exact version-and-digest files use one-year immutable caching and a
  file-digest ETag with `304` support.
- Authenticated/private API responses remain `private, no-store`.
- Cloudflare `_headers` is packaged at the project root as required by the
  adapter.

## Content and accessibility results

- Unit inventory proves the six-step workflow and shipped capabilities.
- Content scanning rejects pricing, purchase, checkout, payout, seller-fee,
  coming-soon, and in-progress claims.
- Axe found no selected WCAG 2.0 A/AA, 2.1 AA, or 2.2 AA violations across 18
  page/theme/viewport combinations.
- Every matrix page had at most one pixel of computed horizontal variance.
- Reduced-motion mode, keyboard focus, skip navigation, mobile menu focus
  movement, Escape dismissal, and focus restoration pass.

## Deliverables summary

Files added:

- landing product/content/API component and route tree under `landing/src/`
- landing static favicon, social card, theme bootstrap, and root `_headers`
- shared `packages/ui/src/markdown.ts` and
  `packages/ui/src/components/SafeMarkdown.svelte`
- public API integration and visibility security suites
- landing content, functional, crawl, accessibility, and visual suites
- real local landing browser harness
- five landing visual goldens
- eight `.conduct/screenshots/phase-14/` captures
- `.conduct/decisions/DECISION-0007-public-discovery-and-cache-contract.md`
- `.conduct/evidence/phase-14/verification.md`
- `.conduct/observations/2026-07-26-phase-14-landing-public-discovery.md`
- `.conduct/logs/engineering/PHASE_14.md`
- this report and stable completion record

Files modified:

- public skill search/domain/error behavior
- API public skill/history/digest routes and observability cache middleware
- UI exports, app Markdown consumption, and package dependencies
- landing Cloudflare/build/package configuration
- root test scripts, workspace manifest, lockfile, and design-system-compliant
  OAuth primary-button color
- `.conduct/ledger.md`, screenshot index, and execution CSV logs

The replaced landing placeholder and duplicated app-local Markdown renderer
were removed. No Superfunctions source was modified.

## Verification summary

Required phase commands:

```text
pnpm test:unit --filter landing
PASS — 1 file, 3 tests

pnpm test:integration --filter public-skills
PASS — 1 file, 4 tests

pnpm test:security --filter public-visibility
PASS — 1 file, 2 tests

pnpm test:a11y --filter landing
PASS — 2 tests

pnpm test:e2e --grep @landing
PASS — 8 tests

pnpm test:crawl
PASS — 1 test

pnpm test:visual --filter landing
PASS — 1 test, 5 goldens
```

Additional gates:

```text
pnpm format:check
PASS

pnpm lint
PASS

pnpm lint:design-system
PASS

pnpm typecheck
PASS — 29/29 tasks; Svelte 0 errors, 0 warnings

pnpm build
PASS — 16/16 workspaces

pnpm deploy:check
PASS — 19/19 tasks; app, landing, and MCP dry-runs

pnpm db:verify
PASS — 31 tables, 15 migrations, public search index selected

pnpm boundaries:verify
PASS

pnpm client-secrets:verify
PASS
```

## Screenshot observations

1. Desktop dark home presents the core value proposition, real workflow,
   capability inventory, security controls, audit example, and CTA without
   visual overload.
2. Mobile light home maintains hierarchy, complete copy, and usable compact
   controls with no horizontal clipping.
3. Desktop light directory keeps search, count, metadata, card, CTA, and
   footer clear at production density.
4. Tablet dark detail keeps sanitized instructions, version history,
   metadata, and MCP connection guidance legible.
5. Mobile dark empty state gives a specific explanation and clear search
   reset.
6. Loading and retryable-error captures show content-shaped skeletons,
   progress messaging, a specific failure, and a usable Retry action.
7. Keyboard mobile capture shows the first navigation link with an explicit
   focus ring; the test then confirms Escape closes and restores focus.

## Audit notes and remaining risks

1. The phase audit found no unresolved requirement, test-vector, privacy,
   accessibility, crawl, or deliverable gap.
2. Digest-addressed content that was already made public can remain in
   intermediary caches for the declared immutable lifetime. Current public
   pointers and origin access revoke immediately; retraction of previously
   public immutable bytes is intentionally not promised.
3. Sitemap generation is deliberately bounded to 10,000 skills per response;
   a future larger directory should introduce a sitemap index.
4. Browser suites must stay serial because the local SvelteKit HMR port and
   Wrangler state are shared; Playwright is configured with one worker.
5. Production deployment, custom-domain verification, Railway/Hyperdrive
   binding, R2 binding, email onboarding, and operational rehearsal belong to
   PHASE_15 and were not started.

## Ready for next phase?

**Yes.** PHASE_14 requirements, audit, and gates pass. PHASE_15 may begin in a
separate execution.

## Blockers

None.
