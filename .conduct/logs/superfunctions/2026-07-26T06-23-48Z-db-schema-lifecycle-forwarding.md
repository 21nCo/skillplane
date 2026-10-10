# Superfunctions schema-wrapper lifecycle fix

- Recorded: `2026-07-26T06:23:48Z`
- Skillplane phase: `PHASE_03`
- External worktree: `/Users/serro/Documents/dev/n/superfunctions`
- Branch: `next`
- Revision before edit: `9cf381238d1d8a11c899d6808ffb0bb73dfe839a`
- Classification: minor shared-library bug fix

## Pre-edit finding

The mandatory SendFn test suite fails:

```text
tests/public_api.test.ts:123
expected adapter.closeCalls 1; received 0
43 tests passed; 1 failed
```

`Sendfn.close()` delegates to `SendfnDb.close()`, which delegates to the
schema-wrapped adapter. `wrapWithSchema()` currently constructs that wrapper
with object spread. Class adapter lifecycle methods live on the prototype and
therefore are not copied by object spread. The wrapper exposes no runtime
`close()` method, so the underlying adapter is never closed.

## Pre-edit overlap check

The following intended paths are clean:

```text
packages/db/src/adapter/schema-codecs.ts
packages/db/src/adapter/__tests__/schema-codecs.test.ts
```

Existing user-owned AuthFn, SendFn export, delivery, package, and lockfile
changes are outside this scope and will be preserved.

## Intended change

1. Explicitly delegate adapter lifecycle and schema-management methods from the
   schema wrapper to the underlying adapter.
2. Add a regression test using prototype-backed lifecycle methods so object
   spread alone cannot satisfy the test.
3. Remove the exact ignored compiler-artifact quartet beside
   `schema-codecs.ts`. Those April artifacts shadow the TypeScript source during
   Vite resolution even though the current compiler emits authoritative output
   to `dist/`:

   ```text
   packages/db/src/adapter/schema-codecs.js
   packages/db/src/adapter/schema-codecs.js.map
   packages/db/src/adapter/schema-codecs.d.ts
   packages/db/src/adapter/schema-codecs.d.ts.map
   ```

## Verification plan

```sh
npm --prefix packages/db test -- --run src/adapter/__tests__/schema-codecs.test.ts
npm --prefix sendfn/typescript test -- --run
npm --prefix sendfn/typescript run build
git diff --check
```

## Rollback

Revert only the explicit delegations and the single lifecycle regression test
recorded in this log. The deleted compiler artifacts were ignored, stale, and
derived from the retained TypeScript source; current build products remain
under `packages/db/dist`. Do not alter any pre-existing dirty path.

## Post-verification

Completed at `2026-07-26T06:29:33Z`.

Tracked external changes are limited to the two pre-checked clean paths:

```text
M packages/db/src/adapter/schema-codecs.ts
M packages/db/src/adapter/__tests__/schema-codecs.test.ts
```

The wrapper now explicitly preserves metadata, internal access, lifecycle
methods, schema-version methods, validation, and optional schema creation.
The regression test constructs a class-like adapter whose lifecycle functions
exist only on its prototype, proving that delegation does not depend on object
spread.

This worktree also contains 84 old ignored compiler artifacts under
`packages/db/src`. Deleting only the `schema-codecs` quartet caused an older
ignored `factory.js` to import a missing sibling, so the quartet was restored
from the freshly built `dist` output. These ignored local products now match the
tracked source and do not appear in Git status. No other generated artifact was
changed.

Final outcomes:

```text
npm --prefix packages/db run typecheck                         PASS
npm --prefix packages/db test -- --run ...schema-codecs...    PASS; 6/6
npm --prefix packages/db run build                             PASS
npm --prefix sendfn/typescript test -- --run                  PASS; 44/44
npm --prefix sendfn/typescript run build                       PASS
git diff --check                                               PASS
```

The existing AuthFn, SendFn export, delivery, package, and lockfile dirty paths
remain untouched. Rollback is limited to the two tracked DB diffs above; the
ignored synchronized quartet can be regenerated from the retained TypeScript
source and current `dist` build.
