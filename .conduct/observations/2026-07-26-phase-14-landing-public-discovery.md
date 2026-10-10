# PHASE_14 landing and public discovery observations

- Public discovery now has a dedicated anonymous endpoint rather than
  repurposing an authenticated workspace route.
- The public authorization predicate runs inside a materialized query before
  ranking. Empty browsing and full-text search use the same signed,
  filter-bound cursor contract.
- Search indexes name, description, tags, current published instructions, and
  only the allowed public search document. Private/workspace instructions,
  contexts, notes, and candidate learning data do not affect public results.
- Current public pointers and HTML revalidate; exact version-and-digest files
  are immutable and carry file-digest ETags.
- Detail pages load the current published version, published history, and
  exact digest-addressed `SKILL.md` from the real API/object-storage path.
- Shared `SafeMarkdown` keeps authenticated and public Markdown behavior on
  one sanitizer and styling contract.
- The landing copy maps directly to implemented product behavior and avoids
  billing, purchase, payout, marketplace, or coming-soon claims.
- Canonical, OpenGraph, Twitter, robots, sitemap, and social-card surfaces are
  present. Sitemap pagination fails closed on repeated cursors or an excessive
  page count.
- Loading, empty, success, validation, hidden/not-found, server error, and
  retry states are implemented. Destructive confirmation is not applicable
  to the read-only public surfaces.
- Keyboard inspection confirmed the skip link, visible focus, mobile-menu
  entry, first-link focus movement, Escape dismissal, and focus restoration.
- Manual screenshot review covered desktop/tablet/mobile, light/dark,
  loading, empty, success, retryable error, and keyboard focus. No clipping,
  unreadable content, or unusable core control was observed.
- The Cloudflare adapter requires `_headers` at the landing project root;
  final build and deploy dry-runs confirm the policy is packaged.
- Browser suites must run serially because SvelteKit's development HMR port
  and local Wrangler state are process-shared. The checked-in Playwright
  configuration already enforces one worker.
- Previously public immutable digest responses can remain in intermediary
  caches for their declared lifetime. Current discovery/detail/history revoke
  at origin and revalidate immediately.
- No Superfunctions source or production external state changed.
