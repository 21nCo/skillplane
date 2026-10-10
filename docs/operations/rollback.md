# Production rollback

Skillplane uses Cloudflare Worker version rollback for application recovery and
forward-only Postgres migrations for data safety. A Worker rollback must never
silently revert or mutate the PostgreSQL schema.

For an McpFn authorization/runtime release, also follow the paired app/MCP
compatibility and provider verification rules in [`mcpfn.md`](./mcpfn.md).

## Automated rehearsal

After a successful `pnpm deploy:all`, run:

```bash
pnpm verify:rollback:production
```

The command:

1. acquires a local exclusive rehearsal lock;
2. verifies every active Worker still equals the recorded release version;
3. snapshots the migration ledger plus count and order-independent full-row
   digest for every public table over an SSL-protected direct PostgreSQL
   connection;
4. rolls MCP and app to their recorded prior versions;
5. runs the blocking app/MCP release smoke suite;
6. rolls app and MCP forward to the recorded release versions even
   when the rollback smoke fails;
7. reruns the app/MCP release smoke and proves database row-state and migration
   hashes did not change; and
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
2. Export `wrangler deployments list --name <worker> --json` for the app and
   MCP Workers.
3. Choose version IDs only from the matching sanitized deployment manifest.
4. Roll back in dependency-safe reverse exposure order: MCP, then app.
5. Run `pnpm smoke:production:release`.
6. If the incident is not resolved, roll forward to the recorded release IDs in
   app, then MCP order and run the release smoke again.

The landing Worker is not a versioned Worker in this repository's release
manifest or automated rollback. Diagnose, repair, and roll it back from its
independently managed workspace. Use `pnpm smoke:production:topology` only as a
cross-system verification after the responsible deployment has been restored.

Never guess a version ID, use a version from another Worker, or change the
PostgreSQL database during a Worker rollback.

## Migration incidents

Committed production migrations are forward-only. If a migration causes an
incident:

1. Stop application writes or deploy a compatible maintenance release.
2. Preserve the pre-migration encrypted backup and its manifest.
3. Prefer a corrective forward migration that retains immutable audit,
   version, context, and note history.
4. If recovery requires restoration, create a new PostgreSQL database and follow
   `backup-restore.md`. Do not restore over the source database.
5. Verify the recovered database, update the Hyperdrive origin, deploy, and
   smoke before switching traffic.

The R2 bucket is not rolled back. Skill bundle keys are content-addressed and
published objects are immutable; restoring a database must reconcile every
recorded key and digest against R2 before traffic moves.
