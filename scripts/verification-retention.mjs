import { Pool } from "pg";
if (!process.env.DATABASE_URL)
  throw new Error("DATABASE_URL must identify the regional database");
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const expired = await client.query(
      `SELECT r.id,r.workspace_id FROM skill_verification_runs r
       JOIN regional_workspace_migration_fences f ON f.workspace_id=r.workspace_id
       WHERE r.expires_at<=now() AND f.source_epoch=0
       ORDER BY r.expires_at LIMIT 500 FOR UPDATE OF r SKIP LOCKED`,
    );
    let deletedRuns = 0;
    for (const workspaceId of new Set(expired.rows.map((row) => row.workspace_id))) {
      // Retention is a routed write too. Hold the active generation against migration.
      const fence = await client.query(
        "SELECT active_epoch FROM regional_workspace_migration_fences WHERE workspace_id=$1 AND source_epoch=0 FOR SHARE",
        [workspaceId],
      );
      if (!fence.rows[0]) continue;
      await client.query(
        "SELECT set_config('skillplane.workspace_routing_epoch',$1,true)",
        [String(fence.rows[0].active_epoch)],
      );
      const ids = expired.rows
        .filter((row) => row.workspace_id === workspaceId)
        .map((row) => row.id);
      await client.query(
        "DELETE FROM skill_verification_claim_results WHERE workspace_id=$1 AND run_id=ANY($2::text[])",
        [workspaceId, ids],
      );
      const result = await client.query(
        "DELETE FROM skill_verification_runs WHERE workspace_id=$1 AND id=ANY($2::text[])",
        [workspaceId, ids],
      );
      deletedRuns += result.rowCount ?? 0;
    }
    await client.query("COMMIT");
    console.log(JSON.stringify({ event: "verification.retention", deletedRuns }));
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
} finally {
  await pool.end();
}
