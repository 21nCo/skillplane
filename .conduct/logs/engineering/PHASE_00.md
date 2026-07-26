# Engineering log: PHASE_00 repository and dependency baseline

- Timestamp: 2026-07-26T04:32:04Z
- Operation: repository, evidence, runtime, and external dependency preflight
- Result: complete

## Scope completed

1. Initialized an isolated Git repository on branch `main`.
2. Added repository policies for formatting, package-manager strictness, secrets,
   dependencies, build output, Wrangler state, database state, and test output.
3. Added `scripts/preflight.mjs` with stable diagnostics and process exit codes
   for runtime, Docker, port, dependency-source, external-overlap, and
   portability failures.
4. Recorded the external worktree baseline without absolute paths.
5. Recorded the immutable dependency and external-edit boundary.
6. Exercised positive and negative preflight paths without modifying any
   external worktree.

## Runtime evidence

| Check | Result |
|---|---|
| Node | `v20.20.0`, supported |
| pnpm | `11.9.0`, supported |
| Docker client | `29.6.1` |
| Docker engine | `29.6.1`, reachable |
| Default Postgres port | `5432`, available |
| Platform | Darwin arm64 |
| Shell | zsh |

## External dependency evidence

| Label | Branch | Commit | Dirty | Changed paths |
|---|---|---|---:|---:|
| `superfunctions-dev` | `dev` | `713f82b3bff8624308473d0d6d19775bd7cbc7b6` | yes | 470 |
| `superfunctions-next` | `next` | `9cf381238d1d8a11c899d6808ffb0bb73dfe839a` | yes | 15 |
| `nucleus` | `TIDY-442` | `555cce730f225d2e1e5f6063cb5119037de6c000` | yes | 854 |

The full relative-path inventory is stored in
`.conduct/dependency-baseline.json`. It contains no external root paths.

## Superfunctions overlap result

Superfunctions edit mode is blocked with `EXTERNAL_WORKTREE_OVERLAP` and exit
code `33`. Existing overlapping paths:

- `packages/delivery/package.json`
- `packages/delivery/src/index.ts`
- `packages/delivery/tsconfig.json`
- `sendfn/typescript/package.json`
- `sendfn/typescript/src/delivery.ts`
- `sendfn/typescript/src/edge.ts`
- `sendfn/typescript/src/index.ts`
- `sendfn/typescript/tests/delivery.test.ts`
- `sendfn/typescript/tsconfig.json`

No external source was edited.

## Environment contract established in this phase

| Name | Purpose | Secret |
|---|---|---:|
| `SKILLPLANE_POSTGRES_PORT` | Deterministic local Postgres host port; defaults to `5432` | no |
| `SKILLPLANE_SUPERFUNCTIONS_DEV_ROOT` | Optional local override for dependency discovery | no |
| `SKILLPLANE_SUPERFUNCTIONS_NEXT_ROOT` | Optional local override for dependency discovery | no |
| `SKILLPLANE_NUCLEUS_ROOT` | Optional local override for read-only reference discovery | no |

Application and deployment names are intentionally defined with their strict
schemas in PHASE_01, alongside `.env.example`, rather than accepted as
unvalidated values in this phase.

## Verification

```sh
node scripts/preflight.mjs --self-test
node scripts/preflight.mjs --mode spec-safe --write-baseline
node scripts/preflight.mjs --mode spec-safe
node scripts/preflight.mjs --check-portability
node scripts/preflight.mjs --mode superfunctions-edit
SKILLPLANE_POSTGRES_PORT=55432 node scripts/preflight.mjs --mode spec-safe
git status --short --branch
git check-ignore -v .env .dev.vars .wrangler/state wrangler.generated.jsonc test-results/result.json
```

Results:

- self-test: PASS, 10 assertions;
- read-only dependency/runtime preflight: PASS;
- baseline generation: PASS;
- portability scan: PASS;
- Superfunctions edit negative vector: PASS, rejected with exit `33`;
- occupied-port negative vector: PASS, rejected with
  `POSTGRES_PORT_OCCUPIED` and exit `23`;
- secret/transient ignore rules: PASS;
- `.env.example` remains eligible for version control: PASS.

## Next safe action

Begin PHASE_01 without adding mutable local Superfunctions or UIFn
dependencies. Re-run this preflight before PHASE_02 dependency integration.
