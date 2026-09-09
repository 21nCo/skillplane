import { cleanupControlPlaneAuditReads } from "@skillplane/control-plane";
import { Pool } from "pg";
import { expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

it("expires only old detailed control reads and preserves permanent and recent evidence", async () => {
  const url = await resolveTestDatabaseUrl();
  await migrateDatabase(url);
  const pool = new Pool({ connectionString: url });
  const prefix = crypto.randomUUID();
  try {
    for (const [kind, retentionClass, age] of [
      ["old-read", "detailed_read_90d", 91],
      ["recent-read", "detailed_read_90d", 89],
      ["permanent", "permanent", 100],
    ] as const) {
      await pool.query(
        `INSERT INTO control_plane_audit_events
        (id, event_type, action, outcome, actor_type, actor_id, request_id, channel, retention_class)
        VALUES ($1, 'mcp.workspaces_list.success', 'workspaces_list', 'success', 'user', 'user:test', $2, 'mcp', $3)`,
        [`${prefix}-${kind}`, prefix, retentionClass],
      );
      await pool.query(
        "UPDATE control_plane_audit_events SET occurred_at = now() - ($2::integer * interval '1 day') WHERE id = $1",
        [`${prefix}-${kind}`, age],
      );
    }
    await cleanupControlPlaneAuditReads({ database: pool });
    const result = await pool.query(
      "SELECT id FROM control_plane_audit_events WHERE request_id = $1 ORDER BY id",
      [prefix],
    );
    expect(result.rows.map((row) => row.id)).toEqual([
      `${prefix}-permanent`,
      `${prefix}-recent-read`,
    ]);
  } finally {
    await pool.query("DELETE FROM control_plane_audit_events WHERE request_id = $1", [
      prefix,
    ]);
    await pool.end();
  }
});
