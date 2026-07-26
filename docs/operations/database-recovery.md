# Database backup and recovery

Skillplane uses Railway Postgres as the production origin. Cloudflare Hyperdrive
is a connection accelerator for Workers, not a backup system and not a migration
endpoint.

## Production backup policy

- Enable Railway's managed backups and point-in-time recovery before production
  traffic is accepted.
- Take a logical `pg_dump --format=custom --no-owner --no-privileges` backup
  before every schema migration.
- Encrypt exported backups, store them outside the database account, and apply a
  retention schedule approved for the workspace data classification.
- Run migrations through a direct Railway connection using
  `MIGRATION_DATABASE_URL`; never route migration DDL through Hyperdrive.

## Restore drill

1. Restore into a new, empty database.
2. Run `pnpm --filter @skillplane/db verify` with `DATABASE_URL` pointing at the
   restored database.
3. Confirm migration hashes, required constraints and triggers, and the query
   plan inventory.
4. Compare referenced skill bundle digests against the R2 inventory before
   switching traffic.
5. Update the Hyperdrive origin only after application smoke tests pass.

For the local disposable drill, start Postgres and run
`pnpm db:migrate && pnpm db:backup:verify`. The command makes a custom-format
backup, restores it into `skillplane_restore_test`, runs the complete schema
verifier, and drops only that explicitly named disposable database.

## Retention and orphan safety

`audit_events` and all context revision tables are append-only. Analytics rollups
may be rebuilt from audit events. Idempotency and rate-limit rows may be removed
only after their `expires_at` value. R2 object deletion must first prove that no
`skill_version_files.r2_object_key` references the object; that storage workflow
is implemented with the skill bundle subsystem.

## R2 inventory and orphan cleanup

The database inventory is authoritative for references; R2 is authoritative for
bytes. Export the database side with a direct Railway connection:

```sql
SELECT version.workspace_id,
       version.skill_id,
       version.id AS version_id,
       version.content_digest,
       version.r2_object_key,
       version.bundle_byte_size
FROM skill_versions AS version
ORDER BY version.workspace_id, version.skill_id, version.revision;
```

Compare that result with a complete, paginated private-bucket listing. Every
database key must exist in R2 and its downloaded bytes must hash to
`content_digest`. A missing or mismatched referenced object is a recovery
incident: stop publication and retrieval for the affected version, restore the
exact bytes from the protected R2/backup inventory, and never substitute another
version.

Cleanup uses `R2BundleRepository.cleanupOrphans` and is deliberately two phase:

1. Complete the full paginated R2 listing. Any listing error aborts with no
   deletion.
2. Read the complete distinct `skill_versions.r2_object_key` reference set. Any
   database error aborts with no deletion.
3. Select only objects older than the configured safety cutoff and absent from
   the reference set.
4. Delete only that explicit key list and record scanned, preserved, and deleted
   counts plus safe key identifiers.

Use a safety cutoff of at least 24 hours in production so an R2-first,
database-second publication cannot race cleanup. Never use a bucket lifecycle
rule to delete bundle objects by age: published history is permanent. The
cleanup implementation preserves referenced objects and fails closed when
listing or reference state is uncertain.

The local executable rehearsal is:

```bash
pnpm test:integration --filter skill-storage
```

It writes a referenced canonical object and an explicit orphan into the local
R2-compatible fixture, runs the same repository cleanup implementation, proves
only the orphan is deleted, verifies referenced file retrieval by digest, and
also proves R2 failure cannot create a visible database version.
