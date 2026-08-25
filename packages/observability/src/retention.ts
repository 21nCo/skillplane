import type { Pool } from "pg";
import { rollupUtcDay } from "./rollups.js";
import { writeAuditEvent } from "./audit.js";

export interface RetentionResult {
  readonly cutoff: string;
  readonly deleted: number;
  readonly batches: number;
  readonly affectedWorkspaces: readonly string[];
}

function utcDay(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function daysBetween(from: Date, to: Date): readonly string[] {
  const days: string[] = [];
  const cursor = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()),
  );
  const end = Date.UTC(to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate());
  while (cursor.getTime() <= end) {
    days.push(utcDay(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return days;
}

export async function runAuditRetention(
  pool: Pool,
  options: {
    readonly now?: Date;
    readonly retentionDays?: number;
    readonly batchSize?: number;
    readonly dryRun?: boolean;
  } = {},
): Promise<RetentionResult> {
  const now = options.now ?? new Date();
  const retentionDays = Math.max(90, Math.floor(options.retentionDays ?? 90));
  const batchSize = Math.min(
    10_000,
    Math.max(1, Math.floor(options.batchSize ?? 1_000)),
  );
  const cutoffDate = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1_000);
  const cutoff = cutoffDate.toISOString();
  const eligible = await pool.query<{
    workspace_id: string;
    earliest_at: Date;
    latest_at: Date;
    event_count: string;
  }>(
    `SELECT workspace_id, min(occurred_at) AS earliest_at,
            max(occurred_at) AS latest_at, count(*)::text AS event_count
       FROM audit_events
      WHERE retention_class = 'detailed_read_90d'
        AND occurred_at < $1
      GROUP BY workspace_id
      ORDER BY workspace_id`,
    [cutoff],
  );
  if (options.dryRun) {
    return {
      cutoff,
      deleted: eligible.rows.reduce((total, row) => total + Number(row.event_count), 0),
      batches: 0,
      affectedWorkspaces: eligible.rows.map((row) => row.workspace_id),
    };
  }
  for (const workspace of eligible.rows) {
    for (const day of daysBetween(workspace.earliest_at, workspace.latest_at)) {
      await rollupUtcDay(pool, {
        day,
        workspaceId: workspace.workspace_id,
        preserveFullerSnapshot: true,
      });
    }
  }
  let deleted = 0;
  let batches = 0;
  let count = 1;
  while (count > 0) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        "skillplane-audit-retention-v1",
      ]);
      await client.query(
        "SELECT set_config('skillplane.audit_retention_job', 'enabled', true)",
      );
      const batch = await client.query<{ id: string }>(
        `WITH candidates AS (
           SELECT id
             FROM audit_events
            WHERE retention_class = 'detailed_read_90d'
              AND occurred_at < $1
            ORDER BY occurred_at, id
            LIMIT $2
            FOR UPDATE SKIP LOCKED
         )
         DELETE FROM audit_events event
          USING candidates
          WHERE event.id = candidates.id
         RETURNING event.id`,
        [cutoff, batchSize],
      );
      count = batch.rowCount ?? 0;
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    if (count > 0) {
      deleted += count;
      batches += 1;
    }
  }
  for (const workspace of eligible.rows) {
    await writeAuditEvent(pool, {
      workspaceId: workspace.workspace_id,
      eventType: "audit.retention.completed",
      action: "audit:retain",
      outcome: "success",
      actorType: "system",
      actorId: "system:audit-retention",
      requestId: `retention:${crypto.randomUUID()}`,
      resourceType: "workspace",
      resourceId: workspace.workspace_id,
      channel: "system",
      retentionClass: "permanent",
      metadata: {
        cutoff,
        deletedEventCount: Number(workspace.event_count),
        retentionDays,
      },
    });
  }
  return {
    cutoff,
    deleted,
    batches,
    affectedWorkspaces: eligible.rows.map((row) => row.workspace_id),
  };
}
