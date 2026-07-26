# PHASE_15 verification evidence

- Completed: `2026-07-26T16:21:35Z`
- Status: `PASS`
- Environment: Darwin arm64, local Docker Postgres on `127.0.0.1:5432`,
  local object storage fixtures, Playwright Chromium, Cloudflare Wrangler
  dry-run

## Required release gates

| Command | Result | Evidence |
|---|---:|---|
| `pnpm test:security` | PASS | 15 files, 67 tests; email 1, auth 4, DataFn 1, API 34, storage 4, MCP 20, release boundary 3 |
| `pnpm test:a11y` | PASS | 15 test cases and 102 Axe analyses across UI, app, context, and landing surfaces |
| `pnpm test:performance` | PASS | 10,000 skills, 100 versions, 100 contexts, 1,000,031 audit rows; all p95 gates pass |
| `pnpm test:recovery` | PASS | fresh/forward/restore migration rehearsal, dump checksum, R2 inventory, and fail-closed cleanup |
| `pnpm test:e2e` | PASS | 27 browser tests: 17 app, 2 app visual, 7 landing, 1 landing visual |
| `pnpm build` | PASS | 16/16 workspace builds |
| `pnpm security:scan` | PASS | 288 runtime source files, 334 bundle files, 17 manifests, 13,437,907 bundle bytes |
| `pnpm deploy:check` | PASS | 19/19 tasks; app, landing, and MCP Worker dry-runs |

Additional post-fix gates:

| Command | Result |
|---|---:|
| `pnpm format:check` | PASS |
| `pnpm lint` | PASS |
| `pnpm typecheck` | PASS — 29/29 tasks; Svelte checks report 0 errors and 0 warnings |
| API readiness failure test | PASS — 1 file, 5 tests |
| Cloudflare Email failure/redaction tests | PASS — 2 files, 4 tests |
| `git diff --check` | PASS |

## Security attack matrix

| Boundary | Attacks and negative cases | Result |
|---|---|---:|
| Browser authentication | Secure/HTTP-only session cookie contract; missing/mismatched CSRF; OTP enumeration; repeat-send limit; Turnstile missing, replay, action mismatch, and outage | PASS |
| Tenant/API/DataFn | Cross-workspace IDs, role escalation, pre-ranking search isolation, secret-bearing DataFn resources, invitation/service-secret leakage, encrypted recipient lookup | PASS |
| OAuth 2.1 | Unregistered/wildcard redirect, wrong PKCE, successful code replay, CSRF consent, resource/audience confusion, bearer query, Basic client auth, refresh reuse/family revocation, registration limit | PASS |
| MCP read | Missing/revoked/under-scoped credentials, resource mismatch, stale session header, incomplete/identity-selecting declaration, private/context concealment, viewer history limits | PASS |
| MCP mutation | Missing scope, insufficient workspace role, traversal, stale base, invalid learning metadata, cross-skill note ID, idempotent safety, audit rollback | PASS |
| Archive | Parent/absolute/backslash traversal, case-fold and NFC collisions, duplicate names, invalid ZIP filename encoding, symlink, per-file/total expansion bomb, 1,000-entry limit, undeclared files, manifest substitution | PASS |
| Content and download | Raw HTML/script/event handlers, `javascript:`/unsafe `data:` URLs, oversized inline content, signed download credential binding, cursor filter binding and tamper rejection | PASS |
| R2 and audit | R2 read failure returns typed redacted error; private reads fail closed on audit failure; candidate object and context revision roll back with failed audit | PASS |
| Redaction | Provider text, email, OTP, prompt/body, tokens, secrets, internal URLs, and unauthorized audit detail remain absent from errors/export | PASS |
| Public boundary | Only active public published rows; no candidate/context/learning/audit data; visibility revocation removes current/history/discovery/digest origin access | PASS |

Release-boundary additions specifically prove UTF-8 NFC duplicate rejection,
invalid filename-encoding rejection, and active Markdown/URL neutralization.

## Accessibility matrix

Every Axe run selects `wcag2a`, `wcag2aa`, `wcag21aa`, and `wcag22aa`.
Every responsive page assertion also permits at most one pixel of computed
horizontal overflow.

| Surface | Matrix | Axe analyses | Result |
|---|---|---:|---:|
| Shared UI workbench | 390/768/1440 px × light/dark plus keyboard dialog | 7 | PASS |
| Skill pages | 7 authenticated routes + public detail × 3 viewports × 2 themes; archive dialog | 49 | PASS |
| Context pages | list/detail/history/note history × 3 viewports × 2 themes; create form and 3 dialogs | 28 | PASS |
| Landing | home/directory/detail × 3 viewports × 2 themes | 18 | PASS |
| Contract tests | matrix inventory, keyboard/focus/dialog/error semantics, landmarks/reduced motion | 3 tests | PASS |

Keyboard evidence covers skip navigation, tabs, menus, command routing,
Enter activation, Escape dismissal, dialog initial focus, and focus
restoration. Screen-reader smoke is represented by the Axe name/role/state
matrix, landmarks, labels, live loading status, route error alert, and
decorative SVG exclusion. Reduced-motion assertions cap meaningful animation
at 0.01 seconds.

No selected WCAG A/AA violation or responsive overflow remains.

## Performance fixture and percentiles

Generated report:
`.data/reports/performance-latest.json`

Fixture:

- 10,000 searchable skills
- 100 immutable versions on the measured skill
- 100 contexts
- 1,000,031 audit events
- 760,759-byte compressed bundle
- 983,056-byte `SKILL.md`
- 25 measured samples per endpoint after setup/warm-up

| Operation | p50 | p95 | Max | Gate |
|---|---:|---:|---:|---:|
| Authenticated search | 82.94 ms | 91.12 ms | 92.89 ms | observed |
| Skill metadata | 3.06 ms | 6.02 ms | 6.37 ms | p95 < 500 ms |
| Audit write | 0.39 ms | 0.62 ms | 0.69 ms | observed |
| Analytics | 4.17 ms | 6.05 ms | 7.06 ms | observed |
| Approximately 1 MiB skill file | 15.93 ms | 17.20 ms | 17.90 ms | p95 < 1,000 ms |

Caching assertions pass:

- private/mutable: `private, no-store`;
- immutable public digest: `public, max-age=31536000, immutable`;
- matching public ETag: `304`.

## Query plans and required indexes

| Query | Planner choice | Planning | Execution | Observation |
|---|---|---:|---:|---|
| Search | `skills_pkey` index scan | 0.297 ms | 0.075 ms | Selective fixture rows already occur first in stable ID order; required GIN search index also exists |
| Audit explorer | `audit_events_workspace_time_idx` + incremental sort | 0.189 ms | 162.058 ms | Reads the latest 100 rows from 1,000,031 events |
| Analytics summary | `analytics_daily_summary_workspace_day_idx` index-only scan | 0.045 ms | 0.040 ms | One workspace/day/skill summary row |

The gate asserts these production indexes by name:

- `analytics_daily_dimensions_lookup_idx`
- `analytics_daily_summary_workspace_day_idx`
- `audit_events_workspace_filters_idx`
- `skill_contexts_workspace_skill_idx`
- `skill_versions_workspace_skill_revision_idx`
- `skills_workspace_search_idx`

## Failure-injection matrix

| Dependency | Injection | Required behavior | Result |
|---|---|---|---:|
| Postgres readiness | Failed dependency probe | Redacted `503` with `POSTGRES_UNAVAILABLE`; no URL/password | PASS |
| Postgres reference lookup | Cleanup reference query failure | Preserve every object and return a safe failure | PASS |
| R2 read | Forced read failure | Typed retryable `R2_READ_FAILED`; no content/provider detail | PASS |
| R2 mutation | Failed object write/audit transaction | No visible database row or leaked object; mutations roll back | PASS |
| Email | Cloudflare binding rejection with recipient/body in provider error | Typed `EMAIL_DELIVERY_FAILED`; recipient, OTP, and provider text removed | PASS |
| Audit read | Durable audit write rejection | Private content withheld with `AUDIT_WRITE_FAILED` | PASS |
| Audit mutation | Postgres trigger rejects audit insert | Candidate, R2 object, and context pointer remain unchanged | PASS |
| Browser data | Injected skill/analytics/public API `503` | Specific alert, request-safe message, Retry action, successful reconciliation | PASS |

## Backup, restore, and R2 inventory

Generated report: `.data/reports/recovery-latest.json`

- Fresh migration: 15 applied.
- Forward migration: 15 already applied.
- Restored migration inventory: 15.
- Source/restored table inventory: 31/31.
- Source/restored R2 references: 1/1.
- R2 reference digest:
  `81c40214af25be3e539cae0f9a7cc1c9eb0332a458774178a22c7db34bca3ba5`.
- Custom dump size: 143,220 bytes.
- Dump SHA-256:
  `2aeb37e6b605ca3c2da387bdee3c22342626f045456ea319161bc306e78d8557`.
- Corrupt checksum was rejected before restore.
- Cleanup scanned two inventory objects, deleted only the old fixture orphan,
  and preserved the referenced object plus failure-injection object.
- Listing and reference-query failures both preserved every object.

Operational commands are documented in
`docs/operations/local-recovery.md`; scripts expose `db:backup`,
`db:restore`, and `r2:orphan-cleanup`.

## Production security scan

- Production runtime source imports contain no test fixture.
- Client/server/Worker bundles contain no test fixture, assigned example
  secret/production ID, credential, local absolute path, or client secret.
- Package production dependencies use allowed protocols.
- High advisories: 0.
- Critical advisories: 0.
- Findings: none.

Accepted lower-severity transitive advisories:

1. Moderate `GHSA-w5hq-g745-h8pq` in `uuid` through SendFn/Firebase
   transports; the affected v3/v5/v6 caller-supplied buffer API is not used by
   the Cloudflare Email adapter.
2. Moderate `GHSA-frvp-7c67-39w9` in `@hono/node-server` through the MCP SDK;
   the affected Windows static-file adapter is not imported by the
   Cloudflare Worker.
3. Low `GHSA-g7r4-m6w7-qqqr` in optional `esbuild`; it affects the Windows
   development server, not the deployed Worker bundles.

## Cloudflare packaging

- App Worker: 3,368.23 KiB upload, 612.29 KiB gzip; Email Send and R2
  bindings recognized.
- Landing Worker: 584.03 KiB upload, 127.75 KiB gzip; assets and application
  origin recognized.
- MCP Worker: 3,163.53 KiB upload, 567.46 KiB gzip; R2 binding recognized.
- All dry-runs exit successfully without deployment.

Wrangler reports one non-blocking tree-shaking warning for an unused bare
`fflate` import generated in an app server chunk. Functional bundle handling,
build, E2E, and Worker packaging all pass.

## Visual observations

The exact E2E gate revalidated every existing production golden. The
Phase 15 screenshot index links the inspected skill, analytics/audit, landing,
error/retry, keyboard-focus, mobile, and destructive-confirmation evidence.

The skill-page golden was made deterministic without relaxing its zero-pixel
threshold: dynamic browser-user suffixes are normalized, route scroll begins
at zero, and the modal is captured at the fixed viewport.

## Unresolved non-blocking risks

1. The three low/moderate transitive advisories above remain until upstream
   dependency releases permit safe upgrades. None is on a deployed Skillplane
   runtime path.
2. Latency and query-plan evidence is local. Railway, Hyperdrive, and
   Cloudflare network behavior must be measured during PHASE_16 smoke testing.
3. Backup/restore and R2 inventory were rehearsed against disposable local
   Postgres and object fixtures, not production Railway/R2 resources.
4. Automated semantic checks do not replace manual VoiceOver/NVDA validation;
   a pre-production assistive-technology smoke remains advisable.
5. Production resource provisioning, real Hyperdrive ID, secrets, DNS,
   Cloudflare Email domain verification, and delivery smoke are PHASE_16
   scope and were not started.

No release-blocking PHASE_15 defect remains.
