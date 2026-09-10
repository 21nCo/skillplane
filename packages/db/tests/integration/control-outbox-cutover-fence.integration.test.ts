import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

describe("control outbox cutover fence", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `skillplane_control_outbox_fence_${suffix}_test`;
  const workspaceId = `workspace:control-outbox-${suffix}`;
  const outboxId = `event:control-outbox-${suffix}`;
  let admin: Pool | null = null;
  let control: Pool | null = null;

  beforeAll(async () => {
    const testUrl = await resolveTestDatabaseUrl();
    const adminAddress = new URL(testUrl);
    adminAddress.pathname = "/postgres";
    admin = new Pool({ connectionString: adminAddress.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);

    const controlAddress = new URL(testUrl);
    controlAddress.pathname = `/${database}`;
    await migrateDatabase(controlAddress.toString(), {
      role: "control",
      initialWorkspaceRegion: "legacy",
      workspaceRegions: ["legacy", "in-south"],
      finalizePhysicalOwnership: false,
    });
    control = new Pool({ connectionString: controlAddress.toString(), max: 2 });

    await control.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Control outbox fence fixture')`,
      [workspaceId, `control-outbox-${suffix}`],
    );
    await control.query(
      `INSERT INTO workspace_placements
         (workspace_id, region_id, epoch, state)
       VALUES ($1, 'legacy', 1, 'active')`,
      [workspaceId],
    );
    await control.query(
      `INSERT INTO regional_projection_outbox
         (id, workspace_id, event_type, payload, fencing_epoch, sequence)
       VALUES ($1, $2, 'resource_route.upsert',
               '{"route":"legacy"}'::jsonb, 1, 1)`,
      [outboxId, workspaceId],
    );
    await control.query(
      `UPDATE topology_cutover_state
          SET state = 'copying', target_region_id = 'in-south',
              started_at = now(), updated_at = now()
        WHERE id = 'legacy-to-cells'`,
    );
    await control.query(
      `UPDATE workspace_placements
          SET epoch = 2, state = 'moving', moving_to_region_id = 'in-south',
              previous_region_id = 'legacy', updated_at = now()
        WHERE workspace_id = $1`,
      [workspaceId],
    );
  }, 90_000);

  afterAll(async () => {
    await control?.end();
    if (!admin) return;
    await admin.query(
      `SELECT pg_terminate_backend(pid)
         FROM pg_stat_activity
        WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [database],
    );
    await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
    await admin.end();
  }, 30_000);

  it("allows drain bookkeeping and only processed cleanup", async () => {
    if (!control) throw new Error("Control database unavailable");

    await expect(
      control.query(
        `UPDATE regional_projection_outbox
            SET claim_token = $2, claimed_at = now(), attempts = attempts + 1,
                last_error = 'retry after cutover'
          WHERE id = $1`,
        [outboxId, `claim:${suffix}`],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      control.query(
        `UPDATE regional_projection_outbox
            SET payload = '{"route":"mutated"}'::jsonb
          WHERE id = $1`,
        [outboxId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      control.query(
        "UPDATE regional_projection_outbox SET workspace_id = $2 WHERE id = $1",
        [outboxId, `workspace:rerouted-${suffix}`],
      ),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      control.query("DELETE FROM regional_projection_outbox WHERE id = $1", [outboxId]),
    ).rejects.toMatchObject({ code: "55000" });
    await expect(
      control.query(
        `UPDATE regional_projection_outbox
            SET claim_token = NULL, claimed_at = NULL, last_error = NULL,
                processed_at = now()
          WHERE id = $1`,
        [outboxId],
      ),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      control.query("DELETE FROM regional_projection_outbox WHERE id = $1", [outboxId]),
    ).resolves.toMatchObject({ rowCount: 1 });
    await expect(
      control.query(
        `INSERT INTO regional_projection_outbox
           (id, workspace_id, event_type, payload, fencing_epoch, sequence)
         VALUES ($1, $2, 'resource_route.upsert', '{}'::jsonb, 1, 2)`,
        [`event:control-outbox-late-${suffix}`, workspaceId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
