# DECISION-0002: External Superfunctions dependency boundary

- Status: accepted
- Date: 2026-07-26

## Context

Skillplane must use AuthFn and DataFn from the Superfunctions `dev` line and
SendFn from the Superfunctions `next` line. The current external worktrees
contain substantial pre-existing changes. In particular, the SendFn package,
its public exports, and the shared delivery package already have uncommitted
changes that overlap the likely Cloudflare Email Service adapter integration.

UIFn was separately audited and is not currently an immutable, release-green
dependency. Skillplane cannot inherit a mutable worktree as its public UI
contract.

## Decision

1. The canonical source locations are identified by labels and environment
   overrides, never by committed absolute paths:
   - `superfunctions-dev` through `SKILLPLANE_SUPERFUNCTIONS_DEV_ROOT`;
   - `superfunctions-next` through `SKILLPLANE_SUPERFUNCTIONS_NEXT_ROOT`;
   - `nucleus` through `SKILLPLANE_NUCLEUS_ROOT` as a read-only integration
     reference.
2. Skillplane will not edit an external worktree while a target or export path
   overlaps pre-existing changes. The `superfunctions-edit` preflight mode
   returns `EXTERNAL_WORKTREE_OVERLAP` in that state.
3. Any later Superfunctions edit requires a pre-edit project log, an explicit
   non-overlap result or user authorization for the exact overlap, and a
   post-edit log containing the diff, validation, compatibility, and rollback.
4. Production dependencies must resolve from an exact released version or a
   committed, content-addressed artifact with its source commit and checksum
   recorded. Mutable branches, absolute file links, and packages produced from
   an unidentified dirty snapshot are prohibited.
5. Development may inspect the external source and may validate a disposable
   content-addressed package artifact, but that artifact cannot enter a
   production lockfile until its source revision is immutable.
6. Skillplane owns `packages/ui`. UIFn may later be used only behind an internal
   adapter after its selected source is clean, immutable, distributable, and
   passes the agreed release gates.

## Consequences

- PHASE_01 can proceed without adding Superfunctions or UIFn dependencies.
- PHASE_02 must re-run the dependency preflight before adding AuthFn or DataFn.
- PHASE_03 must not add the SendFn Cloudflare adapter to the external worktree
  while the current overlapping changes remain unresolved.
- A Skillplane-local composition package is preferred whenever it can use
  stable public Superfunctions APIs without changing those libraries.
- Production deployment is blocked if any Superfunctions dependency remains a
  mutable local path.

## Verification

The repository preflight records only worktree labels, branches, commits, dirty
booleans, and relative changed paths. Its portability mode rejects committed
home-directory paths and file URIs.
