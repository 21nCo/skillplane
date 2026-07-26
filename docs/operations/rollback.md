# Production rollback

Skillplane uses Cloudflare Worker version rollback for application recovery and
forward-only Postgres migrations for data safety. A Worker rollback must never
silently revert or mutate the Railway schema.

## Automated rehearsal

After a successful `pnpm deploy:all`, run:

```bash
pnpm verify:rollback:production
```

The command:

1. acquires a local exclusive rehearsal lock;
2. verifies every active Worker still equals the recorded release version;
3. snapshots the migration ledger plus count and order-independent full-row
   digest for every public table over an SSL-protected direct Railway
   connection;
4. rolls landing, MCP, and app to their recorded prior versions;
5. runs the complete production smoke suite;
6. rolls app, MCP, and landing forward to the recorded release versions even
   when the rollback smoke fails;
7. reruns production smoke and proves database row-state and migration hashes
   did not change; and
8. writes an append-only sanitized rehearsal record under
   `.conduct/deployments/`.

On a first release, `deploy:all` creates an identical baseline version before
the release version so the rollback mechanism can be rehearsed without
inventing a target.

## Incident rollback

Use the automated command for a release that still matches
`.data/production/release.json`. It refuses to overwrite a newer or
out-of-band deployment.

If the current deployment is newer than the local release record:

1. Stop and identify the deployment owner and release manifest.
2. Export `wrangler deployments list --name <worker> --json` for all three
   Workers.
3. Choose version IDs only from the matching sanitized deployment manifest.
4. Roll back in dependency-safe reverse exposure order: landing, MCP, app.
5. Run `pnpm smoke:production`.
6. If the incident is not resolved, roll forward to the recorded release IDs in
   app, MCP, landing order and run smoke again.

Never guess a version ID, use a version from another Worker, or change the
Railway database during a Worker rollback.

## Migration incidents

Committed production migrations are forward-only. If a migration causes an
incident:

1. Stop application writes or deploy a compatible maintenance release.
2. Preserve the pre-migration encrypted backup and its manifest.
3. Prefer a corrective forward migration that retains immutable audit,
   version, context, and note history.
4. If recovery requires restoration, create a new Railway database and follow
   `backup-restore.md`. Do not restore over the source database.
5. Verify the recovered database, update the Hyperdrive origin, deploy, and
   smoke before switching traffic.

The R2 bucket is not rolled back. Skill bundle keys are content-addressed and
published objects are immutable; restoring a database must reconcile every
recorded key and digest against R2 before traffic moves.
