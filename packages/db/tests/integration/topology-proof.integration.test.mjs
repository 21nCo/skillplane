import assert from "node:assert/strict";
import { it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";
import { Pool } from "pg";
import {
  completeTopologyCutover,
  prepareLegacyControlDatabase,
} from "../../../../scripts/migrate-topology-databases.mjs";

it("rejects uncertified legacy migration evidence before completing cutover", async () => {
  const pool = new Pool({ connectionString: await resolveTestDatabaseUrl(), max: 1 });
  try {
    await pool.query(
      "CREATE TEMP TABLE topology_cutover_state (id text, state text, target_region_id text, completed_at timestamptz, updated_at timestamptz)",
    );
    await pool.query("CREATE TEMP TABLE workspaces (id text)");
    await pool.query(
      "CREATE TEMP TABLE workspace_placements (workspace_id text, state text, region_id text, previous_region_id text, epoch bigint)",
    );
    await pool.query(
      "CREATE TEMP TABLE workspace_migration_runs (workspace_id text, source_region_id text, target_region_id text, final_epoch bigint, status text, evidence jsonb)",
    );
    await pool.query(
      "INSERT INTO topology_cutover_state VALUES ('legacy-to-cells', 'copying', 'in-south', NULL, now())",
    );
    await pool.query("INSERT INTO workspaces VALUES ('w')");
    await pool.query(
      "INSERT INTO workspace_placements VALUES ('w', 'active', 'in-south', 'legacy', 5)",
    );
    await pool.query(
      `INSERT INTO workspace_migration_runs VALUES ('w', 'legacy', 'in-south', 5, 'completed', '{"rollbackTested":false}')`,
    );
    await assert.rejects(
      completeTopologyCutover(pool, "in-south"),
      /ROLLBACK_PROOF_REQUIRED/u,
    );
    assert.equal(
      (await pool.query("SELECT state FROM topology_cutover_state")).rows[0].state,
      "copying",
    );
    await pool.query(
      `UPDATE workspace_migration_runs SET evidence = '{"rollbackTested":true}', final_epoch = 4`,
    );
    await assert.rejects(
      completeTopologyCutover(pool, "in-south"),
      /ROLLBACK_PROOF_REQUIRED/u,
    );
    await pool.query("UPDATE workspace_migration_runs SET final_epoch = 5");
    await completeTopologyCutover(pool, "in-south");
    assert.equal(
      (await pool.query("SELECT state FROM topology_cutover_state")).rows[0].state,
      "complete",
    );
  } finally {
    await pool.end();
  }
});

it("applies only control migrations when refreshing a completed pruned cutover", async () => {
  const baseUrl = await resolveTestDatabaseUrl();
  const admin = new Pool({ connectionString: baseUrl, max: 1 });
  const name = `skillplane_refresh_${crypto.randomUUID().replaceAll("-", "")}_test`;
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  let control;
  try {
    await admin.query(`CREATE DATABASE "${name}"`);
    await prepareLegacyControlDatabase(url.href);
    control = new Pool({ connectionString: url.href, max: 1 });
    await control.query(
      "UPDATE topology_cutover_state SET state = 'copying', target_region_id = 'in-south' WHERE id = 'legacy-to-cells'",
    );
    await completeTopologyCutover(control, "in-south");
    await migrateDatabase(url.href, {
      role: "control",
      initialWorkspaceRegion: "in-south",
      workspaceRegions: ["in-south"],
    });
    assert.equal(
      (
        await control.query(
          "SELECT to_regclass('public.regional_projection_outbox') AS relation",
        )
      ).rows[0].relation,
      null,
    );
    // Simulate a pending regional ALTER TABLE after physical ownership pruning.
    await control.query(
      "DELETE FROM skillplane_schema_migrations WHERE id = '0039_regional_generation_safety_hardening.sql'",
    );
    await assert.rejects(
      migrateDatabase(url.href, { role: "combined", finalizePhysicalOwnership: false }),
      /regional_projection_outbox/,
    );
    await prepareLegacyControlDatabase(url.href, migrateDatabase, [
      "legacy",
      "in-south",
    ]);
    const pending = await control.query(
      "SELECT id FROM skillplane_schema_migrations WHERE id = '0039_regional_generation_safety_hardening.sql'",
    );
    assert.equal(pending.rows.length, 0);
    assert.equal(
      (
        await control.query(
          "SELECT state FROM topology_cutover_state WHERE id = 'legacy-to-cells'",
        )
      ).rows[0].state,
      "complete",
    );
  } finally {
    await control?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  }
}, 30000);
