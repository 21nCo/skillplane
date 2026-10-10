# Issue completion: latency-aware workspace placement

## Metadata

- Timestamp: `2026-08-31T07:13:05Z`
- Agent: `unknown-agent`
- Model: `GPT-5`
- Launcher: `Codex Desktop`
- Workspace: repo root
- Environment: `Darwin arm64`, shell `zsh`
- Git branch: `SKI-13`
- Base commit: `4d6ca249ab2ef3a03629c43e48f0119d6fb729f0`
- Initial worktree status: clean
- Issue description: Replace random initial workspace placement with edge-latency placement for personal workspaces and explicit region selection for organization workspaces.

## Issue summary

Initial workspace placement used a deterministic hash, so a user near one regional cell could be assigned to a distant cell. Organization creation also offered no region choice. The gateway now converts trusted Cloudflare edge location into a nearest-region recommendation, personal workspaces use it at first creation, and organization creation requires an explicit region selected in the UI.

## Status

PASS

## Requirements summary

### Place new personal workspaces near the signup edge

- Status: PASS
- Evidence: the gateway strips caller-supplied placement metadata, derives a recommendation from trusted edge coordinates, and fails closed in multi-cell mode when no trusted recommendation is available.
- Dev evidence: a fresh personal signup from the India test edge persisted an active `in-south` placement at epoch 1.

### Require explicit organization-region selection

- Status: PASS
- Evidence: the organization form lists every configured region, marks the edge recommendation, requires a radio selection, and sends the chosen region to an API that validates it against the deployed topology.
- Dev evidence: the form recommended India South; an explicit Europe West override persisted an active `eu-west` placement at epoch 1.

### Keep authentication independent of regional provisioning

- Status: PASS
- Evidence: global authentication and OAuth routes no longer trigger personal-workspace provisioning. Provisioning begins only on workspace-backed API and DataFn routes.
- Dev evidence: the authenticated SSR workspace page recovered from the observed 503 after this boundary was enforced.

## Implementation summary

### Key changes

- Added topology display names and geographic coordinates for India South, US East, and Europe West.
- Added pure nearest-region selection with coordinate and continent fallbacks.
- Added a trusted gateway-only placement header and public-ingress spoofing protection.
- Changed personal workspace creation to use the trusted recommendation instead of hashing.
- Changed organization creation to require a validated region and record `user_selected` placement provenance.
- Added region options and recommendation state to the workspace store and explicit region cards to the organization form.
- Added focused unit, routing, and tenancy integration coverage.

## Verification summary

### Automated verification

- Control-plane unit suite: PASS, 41 tests.
- API unit suite: PASS, 49 tests before the SSR correction; focused post-correction suites: PASS, 22 tests.
- Tenancy integration suite: PASS, 11 tests.
- Domain, control-plane, and API type checks: PASS.
- Svelte check: PASS, 0 errors and 0 warnings.
- Root unit task graph: PASS, 31 tasks.
- Lint and format checks: PASS.
- Deployment dry run: PASS for all 11 gateway and regional workers.
- Isolated public-skill integration suite: PASS, 5 tests.
- Development smoke test: PASS for readiness, OAuth discovery, and authenticated MCP enforcement.
- Development OAuth test: PASS for dynamic registration, PKCE, token exchange, authenticated MCP, and workspace listing.

### Development deployment and browser verification

- Deployed commit `df90d0dc693ef837c3124d54c92aa31a4e80f550` to the development topology.
- Deployment verified one control database, three regional cell databases, disabled Hyperdrive caching, 32 control tables, and 19 tables in each cell.
- Aside Browser used a non-Serro personal profile.
- Verified India South was recommended on organization creation.
- Verified an explicit Europe West selection created and activated the organization.
- Verified a fresh signup created a personal workspace in India South.
- Verified the fresh personal workspace could load its regional Skills view through the gateway.

## Notes

- One broad parallel integration run had four public-skill fixture failures while the tenancy suite passed. The public-skill file passed 5 of 5 when isolated, identifying shared-fixture concurrency rather than a placement regression.
- Existing workspaces are not silently migrated. Placement policy applies at creation; movement remains an explicit managed operation.
- No AuthFn or DataFn package source was changed in this repository.

## Blockers

None.
