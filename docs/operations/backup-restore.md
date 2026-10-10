# Production backup and restore

Provider-managed backups and point-in-time recovery are the first recovery
layer. Skillplane also creates encrypted logical backups before every
production migration so database metadata can be reconciled with immutable R2
objects. `db:migrate:topology` creates and verifies a distinct backup for the
control database and every declared cell before its first mutation; the
standalone command below remains available for an operator-requested control
database backup.

## Create and verify a backup

Set `SKILLPLANE_PRODUCTION_DATABASE_URL` and
`SKILLPLANE_BACKUP_ENCRYPTION_KEY`, then run:

```bash
pnpm db:backup:production
```

The backup process:

- verifies PostgreSQL SSL through `pg_stat_ssl`;
- exports one repeatable-read snapshot for the manifest inventory and
  `pg_dump`;
- captures the migration ledger and every R2 bundle reference;
- runs a Postgres client image matching the server major version and
  creates a custom-format dump with owner and privilege data removed;
- encrypts in memory with AES-256-GCM using a unique salt and IV and a
  scrypt-derived key;
- decrypts in memory and verifies the plaintext digest;
- runs `pg_restore --list` against the decrypted bytes; and
- writes only a mode-`0600` `.dump.enc`, manifest, and sanitized safety state
  below ignored `.data/production/backups/`.

Topology migration backups use the same format and verification beneath
`.data/production/topology-backups/control/` and
`.data/production/topology-backups/cells/<region>/`. Their exact ciphertext
digests and creation times are bound into `topology-migration.json`.

The manifest contains encryption parameters, authentication tag, ciphertext
and plaintext digests, migration hashes, and only the count and digest of the
R2 reference inventory. Tenant, skill, version, and object-key rows remain
inside the encrypted database archive. The manifest does not contain the
passphrase or database credentials.

Copy the encrypted archive and manifest to an approved encrypted backup store
outside the database-provider account. Store the encryption key separately. Enable a
retention policy appropriate for audit and workspace data; never use an R2
lifecycle rule to expire published skill bundles.

## Recovery drill

Create a new, empty PostgreSQL database. Never reuse the production
source. Set:

- `SKILLPLANE_RECOVERY_DATABASE_URL` to its public TCP-proxy URL;
- `SKILLPLANE_BACKUP_ENCRYPTION_KEY` to the backup key.

Run with the exact recovery database name as a destructive confirmation:

```bash
pnpm db:restore:production -- \
  --manifest .data/production/backups/<backup>.manifest.json \
  --confirm-empty-database <recovery-database-name>
```

The restore command fails unless the target is an empty, SSL-protected PostgreSQL
database with a fingerprint different from the backup source. It decrypts into
a unique mode-`0700` temporary directory, supplies the database password to
Postgres through a temporary `.pgpass`, restores with `--exit-on-error`, and
deletes plaintext and password files in a `finally` block.

Before applying current migrations, it proves the restored migration ledger
and R2 reference digest exactly match the backup manifest. It then applies all
remaining committed migrations, runs the complete database verifier, and
writes sanitized drill evidence under
`.data/production/restore-drills/`.

The recovery database remains for operator inspection. Delete it through the
database provider only after the evidence has been reviewed; the script never drops a
remote database.

## R2 reconciliation

Before promoting a recovered database:

1. List the complete private `skillplane-skill-bundles` bucket with pagination.
2. Query every restored `skill_versions` reference and require the exact object
   key.
3. Download each referenced object through an authorized recovery process and
   verify its bytes against the recorded SHA-256 digest and byte size.
4. Treat a missing or mismatched object as an incident. Do not substitute
   another version or advance a current-version pointer.
5. Run orphan cleanup only after the full database and bucket inventories
   succeed. Preserve all referenced objects.

After reconciliation, repoint or recreate the skillplane Hyperdrive
configuration for the recovered PostgreSQL origin, supply the resulting ID to the
normal deployment process, and run every production smoke, OAuth/MCP, email,
and rollback gate before moving traffic.

## Recovery objectives

- Provider-managed PITR covers recent database incidents.
- The pre-migration logical backup provides a portable metadata recovery point.
- Immutable R2 objects plus the manifest reference inventory reconstruct skill
  version bytes.
- Worker version rollback restores code independently from data.

Record the actual RPO/RTO achieved by each production drill. A backup is not
accepted merely because `pg_dump` exited successfully; encryption, archive
listing, restore inventory, forward migrations, schema verification, and R2
reconciliation are all required.
