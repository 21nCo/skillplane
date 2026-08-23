import type { Pool, PoolClient } from "pg";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;
export const ALL_SKILLS_ROLLUP_ID = "";
const DIMENSION_TYPES = [
  ["agent", "agent"],
  ["model", "model"],
  ["context", "context_id"],
  ["tool", "action"],
  ["outcome", "outcome"],
] as const;

export interface RollupResult {
  readonly day: string;
  readonly workspaces: number;
  readonly sourceEvents: number;
}

function requireDay(day: string): string {
  if (!DAY.test(day) || Number.isNaN(new Date(`${day}T00:00:00.000Z`).getTime())) {
    throw new Error("Rollup day must use YYYY-MM-DD");
  }
  return day;
}

async function insertSummary(
  client: PoolClient,
  workspaceId: string,
  day: string,
): Promise<void> {
  await client.query(
    `WITH source AS (
       SELECT event.*, NULLIF(event.metadata->>'skillId', $3) AS event_skill_id,
              CASE
                WHEN event.metadata->>'latencyMs' ~ '^[0-9]+(?:\\.[0-9]+)?$'
                THEN (event.metadata->>'latencyMs')::double precision
              END AS latency_ms,
              (
                event.retention_class = 'detailed_read_90d'
                AND event.action <> 'skill_asset_download'
              ) AS is_retrieval
         FROM audit_events event
        WHERE event.workspace_id = $1
          AND event.occurred_at >= $2::date
          AND event.occurred_at < $2::date + interval '1 day'
     ),
     grouped AS (
       SELECT COALESCE(event_skill_id, $3) AS skill_id,
              count(*) AS event_count,
              count(*) FILTER (
                WHERE is_retrieval AND outcome = 'success'
              ) AS retrieval_count,
              count(*) FILTER (
                WHERE action = 'skills:amend' AND outcome = 'success'
              ) AS amendment_count,
              count(*) FILTER (
                WHERE (
                  event_type IN (
                    'skill.version.published',
                    'amendment.review.approved'
                  )
                  OR event_type LIKE 'amendment.review.approve%'
                ) AND outcome = 'success'
              ) AS approval_count,
              count(*) FILTER (
                WHERE action = 'contexts:write' AND outcome = 'success'
              ) AS context_write_count,
              count(*) FILTER (WHERE outcome <> 'success') AS failure_count,
              count(DISTINCT actor_type || ':' || actor_id) AS unique_principal_count,
              count(DISTINCT agent) FILTER (WHERE agent IS NOT NULL)
                AS unique_agent_count,
              count(DISTINCT model) FILTER (WHERE model IS NOT NULL)
                AS unique_model_count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE is_retrieval AND latency_ms IS NOT NULL)
                AS latency_p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE is_retrieval AND latency_ms IS NOT NULL)
                AS latency_p95_ms,
              count(*) FILTER (
                WHERE is_retrieval
                  AND outcome = 'success'
                  AND metadata->>'versionId' IS NOT NULL
                  AND metadata->>'versionId' = skill.current_published_version_id
              ) AS current_version_retrieval_count,
              count(*) FILTER (
                WHERE is_retrieval
                  AND outcome = 'success'
                  AND metadata->>'versionId' IS NOT NULL
              ) AS versioned_retrieval_count
         FROM source
         LEFT JOIN skills skill
           ON skill.workspace_id = $1 AND skill.id = source.event_skill_id
        GROUP BY event_skill_id
     ),
     workspace_total AS (
       SELECT $3::text AS skill_id,
              count(*) AS event_count,
              count(*) FILTER (
                WHERE is_retrieval AND outcome = 'success'
              ) AS retrieval_count,
              count(*) FILTER (
                WHERE action = 'skills:amend' AND outcome = 'success'
              ) AS amendment_count,
              count(*) FILTER (
                WHERE (
                  event_type IN (
                    'skill.version.published',
                    'amendment.review.approved'
                  )
                  OR event_type LIKE 'amendment.review.approve%'
                ) AND outcome = 'success'
              ) AS approval_count,
              count(*) FILTER (
                WHERE action = 'contexts:write' AND outcome = 'success'
              ) AS context_write_count,
              count(*) FILTER (WHERE outcome <> 'success') AS failure_count,
              count(DISTINCT actor_type || ':' || actor_id) AS unique_principal_count,
              count(DISTINCT agent) FILTER (WHERE agent IS NOT NULL)
                AS unique_agent_count,
              count(DISTINCT model) FILTER (WHERE model IS NOT NULL)
                AS unique_model_count,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE is_retrieval AND latency_ms IS NOT NULL)
                AS latency_p50_ms,
              percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                FILTER (WHERE is_retrieval AND latency_ms IS NOT NULL)
                AS latency_p95_ms,
              count(*) FILTER (
                WHERE is_retrieval
                  AND outcome = 'success'
                  AND metadata->>'versionId' IS NOT NULL
                  AND metadata->>'versionId' = skill.current_published_version_id
              ) AS current_version_retrieval_count,
              count(*) FILTER (
                WHERE is_retrieval
                  AND outcome = 'success'
                  AND metadata->>'versionId' IS NOT NULL
              ) AS versioned_retrieval_count
         FROM source
         LEFT JOIN skills skill
           ON skill.workspace_id = $1 AND skill.id = source.event_skill_id
     ),
     combined AS (
       SELECT * FROM grouped WHERE skill_id <> $3
       UNION ALL
       SELECT * FROM workspace_total
     )
     INSERT INTO analytics_daily_summary (
       workspace_id, day, skill_id, event_count, retrieval_count,
       amendment_count, approval_count, context_write_count, failure_count,
       unique_principal_count, unique_agent_count, unique_model_count,
       latency_p50_ms, latency_p95_ms, current_version_retrieval_count,
       versioned_retrieval_count
     )
     SELECT $1, $2::date, skill_id, event_count, retrieval_count,
            amendment_count, approval_count, context_write_count, failure_count,
            unique_principal_count, unique_agent_count, unique_model_count,
            latency_p50_ms, latency_p95_ms, current_version_retrieval_count,
            versioned_retrieval_count
       FROM combined`,
    [workspaceId, day, ALL_SKILLS_ROLLUP_ID],
  );
}

async function insertDimensions(
  client: PoolClient,
  workspaceId: string,
  day: string,
): Promise<void> {
  for (const [type, column] of DIMENSION_TYPES) {
    await client.query(
      `WITH source AS (
         SELECT event.*, COALESCE(event.metadata->>'skillId', $4) AS skill_id
           FROM audit_events event
          WHERE event.workspace_id = $1
            AND event.occurred_at >= $2::date
            AND event.occurred_at < $2::date + interval '1 day'
            AND ${column} IS NOT NULL
            AND ${column} <> ''
       ),
       rows AS (
         SELECT skill_id, ${column}::text AS dimension_value,
                count(*) AS event_count,
                count(*) FILTER (WHERE outcome <> 'success') AS failure_count,
                count(DISTINCT actor_type || ':' || actor_id)
                  AS unique_principal_count
           FROM source
          WHERE skill_id <> $4
          GROUP BY skill_id, ${column}
         UNION ALL
         SELECT $4, ${column}::text,
                count(*),
                count(*) FILTER (WHERE outcome <> 'success'),
                count(DISTINCT actor_type || ':' || actor_id)
           FROM source
          GROUP BY ${column}
       )
       INSERT INTO analytics_daily_dimensions (
         workspace_id, day, skill_id, dimension_type, dimension_value,
         event_count, failure_count, unique_principal_count
       )
       SELECT $1, $2::date, skill_id, $3, dimension_value,
              event_count, failure_count, unique_principal_count
         FROM rows`,
      [workspaceId, day, type, ALL_SKILLS_ROLLUP_ID],
    );
  }
  await client.query(
    `WITH source AS (
       SELECT event.*, COALESCE(event.metadata->>'skillId', $3) AS skill_id,
              event.metadata->>'versionId' AS dimension_value
         FROM audit_events event
        WHERE event.workspace_id = $1
          AND event.occurred_at >= $2::date
          AND event.occurred_at < $2::date + interval '1 day'
          AND event.metadata->>'versionId' IS NOT NULL
     ),
     rows AS (
       SELECT skill_id, dimension_value, count(*) AS event_count,
              count(*) FILTER (WHERE outcome <> 'success') AS failure_count,
              count(DISTINCT actor_type || ':' || actor_id)
                AS unique_principal_count
         FROM source
        WHERE skill_id <> $3
        GROUP BY skill_id, dimension_value
       UNION ALL
       SELECT $3, dimension_value, count(*),
              count(*) FILTER (WHERE outcome <> 'success'),
              count(DISTINCT actor_type || ':' || actor_id)
         FROM source
        GROUP BY dimension_value
     )
     INSERT INTO analytics_daily_dimensions (
       workspace_id, day, skill_id, dimension_type, dimension_value,
       event_count, failure_count, unique_principal_count
     )
     SELECT $1, $2::date, skill_id, 'version', dimension_value,
            event_count, failure_count, unique_principal_count
       FROM rows`,
    [workspaceId, day, ALL_SKILLS_ROLLUP_ID],
  );
}

async function rollupWorkspace(
  pool: Pool,
  workspaceId: string,
  day: string,
  preserveFullerSnapshot: boolean,
): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      `skillplane-rollup:${workspaceId}:${day}`,
    ]);
    const source = await client.query<{
      event_count: string;
      latest_event_at: Date | null;
    }>(
      `SELECT count(*)::text AS event_count, max(occurred_at) AS latest_event_at
         FROM audit_events
        WHERE workspace_id = $1
          AND occurred_at >= $2::date
          AND occurred_at < $2::date + interval '1 day'`,
      [workspaceId, day],
    );
    const row = source.rows[0];
    const eventCount = Number(row?.event_count ?? 0);
    if (preserveFullerSnapshot) {
      const existing = await client.query<{ source_event_count: string }>(
        `SELECT source_event_count
           FROM analytics_rollup_runs
          WHERE workspace_id = $1 AND day = $2::date`,
        [workspaceId, day],
      );
      if (Number(existing.rows[0]?.source_event_count ?? 0) > eventCount) {
        await client.query("COMMIT");
        return eventCount;
      }
    }
    await client.query(
      "DELETE FROM analytics_daily_dimensions WHERE workspace_id = $1 AND day = $2",
      [workspaceId, day],
    );
    await client.query(
      "DELETE FROM analytics_daily_summary WHERE workspace_id = $1 AND day = $2",
      [workspaceId, day],
    );
    await insertSummary(client, workspaceId, day);
    await insertDimensions(client, workspaceId, day);
    await client.query(
      `INSERT INTO analytics_rollup_runs (
         workspace_id, day, source_event_count, source_latest_event_at,
         completed_at
       ) VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (workspace_id, day)
       DO UPDATE SET
         source_event_count = EXCLUDED.source_event_count,
         source_latest_event_at = EXCLUDED.source_latest_event_at,
         completed_at = now()`,
      [workspaceId, day, eventCount, row?.latest_event_at ?? null],
    );
    await client.query("COMMIT");
    return eventCount;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function rollupUtcDay(
  pool: Pool,
  options: {
    readonly day: string;
    readonly workspaceId?: string;
    readonly preserveFullerSnapshot?: boolean;
  },
): Promise<RollupResult> {
  const day = requireDay(options.day);
  const workspaces = options.workspaceId
    ? [{ workspace_id: options.workspaceId }]
    : (
        await pool.query<{ workspace_id: string }>(
          `SELECT workspace_id
             FROM (
               SELECT DISTINCT workspace_id
                 FROM audit_events
                WHERE occurred_at >= $1::date
                  AND occurred_at < $1::date + interval '1 day'
               UNION
               SELECT workspace_id
                 FROM analytics_rollup_runs
                WHERE day = $1::date
             ) source
            ORDER BY workspace_id`,
          [day],
        )
      ).rows;
  let sourceEvents = 0;
  for (const row of workspaces) {
    sourceEvents += await rollupWorkspace(
      pool,
      row.workspace_id,
      day,
      options.preserveFullerSnapshot ?? false,
    );
  }
  return { day, workspaces: workspaces.length, sourceEvents };
}
