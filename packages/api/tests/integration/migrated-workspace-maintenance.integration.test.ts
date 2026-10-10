import { Pool } from "pg";
import { expect, it } from "vitest";
import {
  rollupUtcDay,
  runAuditRetention,
  writeAuditEvent,
} from "@skillplane/observability";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";

it("skips retained source data and maintains subsequent active workspaces", async () => {
  const name = `maintenance_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}_test`;
  const address = new URL(await resolveTestDatabaseUrl());
  address.pathname = "/postgres";
  const admin = new Pool({ connectionString: address.toString() });
  await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
  address.pathname = `/${name}`;
  const database = new Pool({ connectionString: address.toString(), max: 4 });
  const occurredAt = new Date(Date.now() - 100 * 86_400_000);
  try {
    await migrateDatabase(address.toString());
    for (const workspaceId of ["a-moved", "z-active"]) {
      await database.query(
        "INSERT INTO workspaces (id, workspace_id, slug, name) VALUES ($1, $1, $1, $1)",
        [workspaceId],
      );
      await writeAuditEvent(database, {
        workspaceId,
        eventType: "skill.retrieved",
        action: "skill:read",
        outcome: "success",
        actorType: "system",
        actorId: "system:matrix",
        requestId: crypto.randomUUID(),
        retentionClass: "detailed_read_90d",
        occurredAt,
      });
    }
    await database.query(`INSERT INTO regional_workspace_migration_fences
      (workspace_id, source_epoch, active_epoch) VALUES ('a-moved', 1, 1) ON CONFLICT (workspace_id) DO UPDATE SET source_epoch = 1`);
    await expect(
      rollupUtcDay(database, { day: occurredAt.toISOString().slice(0, 10) }),
    ).resolves.toMatchObject({
      workspaces: 1,
      sourceEvents: 1,
    });
    await expect(runAuditRetention(database, { dryRun: true })).resolves.toMatchObject({
      deleted: 1,
      affectedWorkspaces: ["z-active"],
    });
    await expect(runAuditRetention(database)).resolves.toMatchObject({
      deleted: 1,
      affectedWorkspaces: ["z-active"],
    });
    expect(
      (
        await database.query(
          "SELECT workspace_id FROM audit_events WHERE retention_class = 'detailed_read_90d'",
        )
      ).rows,
    ).toEqual([{ workspace_id: "a-moved" }]);
  } finally {
    await database.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 90_000);
