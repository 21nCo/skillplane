import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

describe("workspace placement region safety", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `skillplane_placement_region_${suffix}_test`;
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
    control = new Pool({ connectionString: controlAddress.toString(), max: 5 });
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

  it("requires declared enabled current and moving regions", async () => {
    if (!control) throw new Error("Control database unavailable");
    const currentWorkspace = `workspace:invalid-current-${suffix}`;
    const movingWorkspace = `workspace:invalid-moving-${suffix}`;
    await control.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Invalid current region'),
              ($3, $3, $4, 'Invalid moving region')`,
      [
        currentWorkspace,
        `invalid-current-${suffix}`,
        movingWorkspace,
        `invalid-moving-${suffix}`,
      ],
    );

    await expect(
      control.query(
        `INSERT INTO workspace_placements
           (workspace_id, region_id, epoch, state)
         VALUES ($1, 'undeclared', 1, 'active')`,
        [currentWorkspace],
      ),
    ).rejects.toBeDefined();
    await expect(
      control.query(
        `INSERT INTO workspace_placements
           (workspace_id, region_id, epoch, state, moving_to_region_id)
         VALUES ($1, 'legacy', 2, 'moving', 'undeclared')`,
        [movingWorkspace],
      ),
    ).rejects.toBeDefined();
  });

  it("blocks disabling, deleting, or renaming referenced regions", async () => {
    if (!control) throw new Error("Control database unavailable");
    const workspaceId = `workspace:protected-region-${suffix}`;
    await control.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Protected region')`,
      [workspaceId, `protected-region-${suffix}`],
    );
    await control.query(
      `INSERT INTO workspace_placements
         (workspace_id, region_id, epoch, state, moving_to_region_id)
       VALUES ($1, 'legacy', 2, 'moving', 'in-south')`,
      [workspaceId],
    );

    await expect(
      control.query(
        "UPDATE workspace_regions SET enabled = false WHERE region_id = 'in-south'",
      ),
    ).rejects.toBeDefined();
    await expect(
      control.query(
        "UPDATE workspace_regions SET region_id = 'south-renamed' WHERE region_id = 'in-south'",
      ),
    ).rejects.toBeDefined();
    await expect(
      control.query("DELETE FROM workspace_regions WHERE region_id = 'legacy'"),
    ).rejects.toBeDefined();
  });

  it("serializes placement validation with concurrent region disabling", async () => {
    if (!control) throw new Error("Control database unavailable");
    const workspaceId = `workspace:region-race-${suffix}`;
    await control.query(
      `INSERT INTO workspaces (id, workspace_id, slug, name)
       VALUES ($1, $1, $2, 'Region race')`,
      [workspaceId, `region-race-${suffix}`],
    );
    await control.query(
      "INSERT INTO workspace_regions (region_id) VALUES ('race-region')",
    );

    const placement = await control.connect();
    const region = await control.connect();
    try {
      await placement.query("BEGIN");
      await placement.query(
        `INSERT INTO workspace_placements
           (workspace_id, region_id, epoch, state)
         VALUES ($1, 'race-region', 1, 'active')`,
        [workspaceId],
      );
      await region.query("BEGIN");
      await region.query(
        "UPDATE workspace_regions SET enabled = false WHERE region_id = 'race-region'",
      );

      const placementCommit = placement.query("COMMIT");
      await region.query("COMMIT");
      await expect(placementCommit).rejects.toBeDefined();
      await expect(
        control.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM workspace_placements
            WHERE workspace_id = $1`,
          [workspaceId],
        ),
      ).resolves.toMatchObject({ rows: [{ count: "0" }] });
    } finally {
      await Promise.allSettled([placement.query("ROLLBACK"), region.query("ROLLBACK")]);
      placement.release();
      region.release();
    }
  });
});
