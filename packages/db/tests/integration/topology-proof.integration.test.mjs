import assert from "node:assert/strict";
import { it } from "vitest";
import { resolveTestDatabaseUrl } from "../../src/index.js";
import { Pool } from "pg";
import { completeTopologyCutover } from "../../../../scripts/migrate-topology-databases.mjs";

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
