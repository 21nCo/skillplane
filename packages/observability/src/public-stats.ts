import type { Pool } from "pg";

export interface PublicStats {
  readonly totalSkills: number;
  readonly agentSkillUses: number;
}

interface PublicStatsRow {
  readonly total_skills: string;
  readonly agent_skill_uses: string;
}

function count(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error("Public statistics returned an invalid count");
  }
  return parsed;
}

export async function readPublicStats(pool: Pool): Promise<PublicStats> {
  const result = await pool.query<PublicStatsRow>(
    `WITH active_skills AS (
       SELECT count(*)::bigint AS total
         FROM skills
        WHERE archived_at IS NULL
     ),
     rolled_agent_uses AS (
       SELECT COALESCE(
                sum(GREATEST(event_count - failure_count, 0)),
                0
              )::bigint AS total
         FROM analytics_daily_dimensions
        WHERE skill_id = ''
          AND dimension_type = 'tool'
          AND dimension_value = 'skill_retrieve'
     ),
     unrolled_agent_uses AS (
       SELECT count(*)::bigint AS total
         FROM audit_events event
         LEFT JOIN analytics_rollup_runs rollup
           ON rollup.workspace_id = event.workspace_id
          AND rollup.day = (event.occurred_at AT TIME ZONE 'UTC')::date
        WHERE event.action = 'skill_retrieve'
          AND event.outcome = 'success'
          AND (
            rollup.workspace_id IS NULL
            OR rollup.source_latest_event_at IS NULL
            OR event.occurred_at > rollup.source_latest_event_at
          )
     )
     SELECT active_skills.total::text AS total_skills,
            (rolled_agent_uses.total + unrolled_agent_uses.total)::text
              AS agent_skill_uses
       FROM active_skills, rolled_agent_uses, unrolled_agent_uses`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Public statistics query returned no rows");
  return {
    totalSkills: count(row.total_skills),
    agentSkillUses: count(row.agent_skill_uses),
  };
}
