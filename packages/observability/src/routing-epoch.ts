import type { PoolClient } from "pg";

/** Pins trusted maintenance to the current generation without bypassing a source fence. */
export async function setCurrentWorkspaceRoutingEpoch(
  client: PoolClient,
  workspaceId: string,
): Promise<number> {
  await client.query(
    `INSERT INTO regional_workspace_migration_fences
       (workspace_id, source_epoch, active_epoch)
     VALUES ($1, 0, 1)
     ON CONFLICT (workspace_id) DO NOTHING`,
    [workspaceId],
  );
  const fence = await client.query<{ source_epoch: string; active_epoch: string }>(
    `SELECT source_epoch::text, active_epoch::text
       FROM regional_workspace_migration_fences
      WHERE workspace_id = $1
      FOR SHARE`,
    [workspaceId],
  );
  const row = fence.rows[0];
  if (!row || Number(row.source_epoch) > 0) {
    throw new Error("WORKSPACE_MAINTENANCE_FENCED");
  }
  const epoch = Number(row.active_epoch);
  if (!Number.isSafeInteger(epoch) || epoch < 1) {
    throw new Error("WORKSPACE_MAINTENANCE_EPOCH_INVALID");
  }
  await client.query(
    "SELECT set_config('skillplane.workspace_routing_epoch', $1, true)",
    [String(epoch)],
  );
  return epoch;
}
