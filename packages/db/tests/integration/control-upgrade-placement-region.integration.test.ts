import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  loadMigrations,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "../../src/index.js";

// Reproduces a populated database upgrading directly from the pre-control-plane
// migration set to `role: "control"`. 0023 remaps the seeded legacy placement
// onto the requested initial region before 0043 adds the placement-region
// foreign keys, so an immediate constraint scan would abort the conversion
// before the migrator seeds the configured regions.
describe("control conversion of a populated pre-control-plane database", () => {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
  const database = `skillplane_control_upgrade_${suffix}_test`;
  const workspaceId = `workspace:control-upgrade-${suffix}`;
  let admin: Pool | null = null;
  let databaseUrl = "";

  beforeAll(async () => {
    const testUrl = await resolveTestDatabaseUrl();
    const adminAddress = new URL(testUrl);
    adminAddress.pathname = "/postgres";
    admin = new Pool({ connectionString: adminAddress.toString(), max: 1 });
    await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
    const address = new URL(testUrl);
    address.pathname = `/${database}`;
    databaseUrl = address.toString();

    // Apply only the migrations that predate the control-plane split (0020),
    // recording them in the ledger exactly as the migrator would, so the
    // subsequent control conversion applies 0020+ against a populated schema.
    const preControlPlane = (await loadMigrations()).filter(
      (migration) => migration.id < "0020",
    );
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS skillplane_schema_migrations (
          id text PRIMARY KEY,
          sha256 text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now(),
          execution_ms integer NOT NULL CHECK (execution_ms >= 0)
        )
      `);
      for (const migration of preControlPlane) {
        await pool.query(migration.sql);
        await pool.query(
          `INSERT INTO skillplane_schema_migrations (id, sha256, execution_ms)
           VALUES ($1, $2, 0)`,
          [migration.id, migration.sha256],
        );
      }
      await pool.query(
        `INSERT INTO workspaces (id, workspace_id, slug, name)
         VALUES ($1, $1, $2, 'Pre-control-plane fixture')`,
        [workspaceId, `control-upgrade-${suffix}`],
      );
    } finally {
      await pool.end();
    }
  }, 90_000);

  afterAll(async () => {
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

  it("reconciles the seeded placement onto the declared initial region", async () => {
    await expect(
      migrateDatabase(databaseUrl, {
        role: "control",
        initialWorkspaceRegion: "in-south",
        workspaceRegions: ["in-south", "us-east"],
        finalizePhysicalOwnership: false,
      }),
    ).resolves.toMatchObject({ role: "control" });

    const control = new Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const placement = await control.query<{ region_id: string }>(
        "SELECT region_id FROM workspace_placements WHERE workspace_id = $1",
        [workspaceId],
      );
      expect(placement.rows[0]?.region_id).toBe("in-south");

      const regions = await control.query<{ region_id: string; enabled: boolean }>(
        "SELECT region_id, enabled FROM workspace_regions ORDER BY region_id",
      );
      expect(regions.rows).toEqual(
        expect.arrayContaining([
          { region_id: "in-south", enabled: true },
          { region_id: "us-east", enabled: true },
        ]),
      );

      // The foreign keys must be fully validated after reconciliation.
      const validated = await control.query<{ conname: string }>(
        `SELECT conname
           FROM pg_constraint
          WHERE conrelid = 'workspace_placements'::regclass
            AND conname IN (
              'workspace_placements_region_id_fkey',
              'workspace_placements_moving_to_region_id_fkey'
            )
            AND NOT convalidated`,
      );
      expect(validated.rows).toEqual([]);
    } finally {
      await control.end();
    }
  }, 90_000);
});
