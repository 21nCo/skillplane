# Landing extraction and independent redeploy

- Completed: `2026-08-04T07:00:00Z`
- Status: PASS
- Scope: move the landing Worker into the 21n monorepo, decouple it from the
  Skillplane backend release, update visual identity, and redeploy the apex.

## Ownership change

- Moved the landing application from this repository's `landing/` workspace to
  `/Users/serro/Documents/dev/n/21n/landing/skillplane`.
- Removed the landing workspace, build/test runners, generated Wrangler
  template, Worker inventory, and rollback transitions from this repository.
- Kept the public landing endpoint in production smoke coverage while making
  the landing Worker deployment independent from app/MCP releases.
- The standalone package owns `skillplane-landing` and the existing
  `skillplane.dev/*` zone route; the externally managed apex DNS record remains
  unchanged.

## Visual and package changes

- Replaced the shared private `@skillplane/ui` dependency with local landing
  tokens and the two required local components.
- Imported `@21n/fonts/styles.css` and set `Twenty One Native` as the site font.
- Updated the hero and social metadata to `Skills that self-improve`.
- Set the logo-purple family as the accent palette and implemented an original
  layered purple atmosphere with CSS gradients and star fields. No third-party
  background asset was copied or bundled.

## Verification

- `svelte-check`: 0 errors, 0 warnings.
- Landing content tests: 3 passed.
- Production build and Wrangler dry run passed; all eight Twenty One Native
  WOFF2 files were emitted as immutable assets.
- Local responsive checks at 1440x900 dark and 390x844 light showed no overflow
  or browser errors. Keyboard skip-link/mobile navigation passed. Axe reported
  zero WCAG A/AA violations in both viewports.
- The remaining Skillplane app/MCP monorepo build passed all 15 workspaces.
  Deployment config dry runs passed for both Workers.

## Cloudflare release

- Worker: `skillplane-landing`
- Route: `skillplane.dev/*`
- Version: `08aefd54-1bd6-4ad9-b582-c02743623d17`
- Production browser verification returned HTTP 200, loaded Twenty One Native
  assets, rendered the new title/headline, had no horizontal overflow or
  console errors, and passed Axe with zero violations.
- Full production smoke passed for landing, app, MCP, Postgres/Hyperdrive, R2,
  OAuth/PKCE boundaries, cache policy, and unauthenticated MCP challenge.

## Named-style background follow-up

- Replaced the initial atmospheric treatment with an original generated
  near-black ribbon composition based on the selected Surrealis 3 collection
  direction. The generated artwork uses Skillplane violet rim lighting, keeps
  negative space behind the hero copy, and includes no Backgrounds Supply
  assets.
- Removed the CSS haze and star layers. Added a 1672x941 responsive WebP hero
  asset (46 KiB) and rebuilt the 1200x630 social card with matching layered
  ribbon geometry.
- `svelte-check` remained at 0 errors and 0 warnings; all 4 landing content
  tests passed. The production build and Wrangler dry run passed.
- Local and production checks at 1440x1000 and 390x844 loaded the new WebP and
  Twenty One Native, had no overflow, and reported zero Axe WCAG A/AA
  violations. Fresh production browser sessions had no console errors.
- Worker: `skillplane-landing`
- Route: `skillplane.dev/*`
- Version: `0ddd2476-15c3-489e-b584-912952f93312`
- The full production smoke passed again after the background release.
