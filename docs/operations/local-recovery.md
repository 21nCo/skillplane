# Local backup, restore, and R2 inventory recovery

These commands rehearse Skillplane recovery against the local Docker Postgres
runtime. They never connect to Railway or Cloudflare. Destructive restore
operations accept only a loopback Postgres URL whose database name ends in
`_test`.

The project-owned Postgres container binds to host port `55432` by default.
Starting or migrating it updates only `RUNTIME_ENV`, `DATABASE_ADAPTER`, and
`DATABASE_URL` in the ignored Worker variable files. Authentication and OAuth
values are preserved. Run `pnpm local:init` once after the first `pnpm db:up`
to create stable local secrets without printing them.

## Create a backup

Start the local database and migrate it, then create a custom-format Postgres
dump and its reconstruction manifest:

```bash
pnpm db:up
pnpm db:migrate
pnpm db:backup -- --output .data/backups/skillplane.dump
```

The dump is mode `0600`. Its adjacent `.manifest.json` records the dump SHA-256,
the complete migration ledger, and every skill-version R2 object key, content
digest, and byte size. Keep the dump and manifest together. The manifest is the
database-derived inventory needed to reconstruct which immutable R2 bundles are
authoritative after a restore.

The command refuses to overwrite an artifact unless `--overwrite` is explicit.
It accepts only local database URLs; the default comes from
`.data/local-runtime.json`.

## Restore into a disposable database

Use a local database name ending in `_test`:

```bash
pnpm db:restore -- \
  --input .data/backups/skillplane.dump \
  --database-url postgresql://skillplane:LOCAL_PASSWORD@127.0.0.1:55432/skillplane_restore_test
```

Restore verifies the dump checksum before creating the target. It then recreates
the named test database, runs `pg_restore --exit-on-error`, verifies the entire
schema contract and migration hashes, and compares the restored R2 reference
inventory with the manifest. A checksum or restore failure leaves no partially
restored target database.

Do not paste real credentials into documentation, shell history, or `.conduct`.
Use the ignored local runtime file or a temporary environment variable.

## Rehearse orphan cleanup

```bash
pnpm r2:orphan-cleanup -- \
  --manifest .data/backups/skillplane.dump.manifest.json
```

The local rehearsal constructs an R2-compatible inventory, preserves a referenced
bundle from the manifest, deletes only an older unreferenced object, and injects
both listing and reference-inventory failures. Either failure must return
`R2_CLEANUP_FAILED` before deletion.

The production cleanup algorithm is two-phase:

1. Complete every page of the private R2 inventory.
2. Complete the authoritative Postgres reference inventory.
3. Delete only objects older than the safety cutoff and absent from the complete
   reference set.

No deletion is allowed when either inventory is incomplete. Production R2
execution is performed inside the bound Worker; this local command deliberately
has no Cloudflare credentials.

## Run the complete recovery gate

```bash
pnpm test:recovery
```

The gate creates a fresh disposable database, applies all migrations, reapplies
them to prove forward/idempotent upgrade behavior, seeds a version reference,
backs up, restores into a second database, verifies schema and R2 inventory
equivalence, rejects a corrupt checksum, and exercises fail-closed orphan
cleanup. All rehearsal databases are dropped in `finally` cleanup.

For production Railway/Hyperdrive incident policy, retention, and RPO/RTO, see
`docs/operations/database-recovery.md`.
