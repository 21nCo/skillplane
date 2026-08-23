import type { Pool } from "pg";
import { ALL_SKILLS_ROLLUP_ID } from "./rollups.js";

export interface PublicStats {
  readonly totalSkills: string;
  readonly agentSkillUses: string;
}

interface PublicStatsRow {
  readonly total_skills: string;
  readonly agent_skill_uses: string;
}

function count(value: string): string {
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    throw new Error("Public statistics returned an invalid count");
  }
  return value;
}

export async function readPublicStats(pool: Pool): Promise<PublicStats> {
  const result = await pool.query<PublicStatsRow>(
    `WITH active_skills AS (
       SELECT count(*)::bigint AS total
         FROM skills
        WHERE archived_at IS NULL
     ),
     rolled_agent_uses_by_day AS (
       SELECT workspace_id, day,
              sum(GREATEST(event_count - failure_count, 0))::bigint AS total
         FROM analytics_daily_dimensions
        WHERE skill_id = $1
          AND dimension_type = 'tool'
          AND dimension_value = 'skill_retrieve'
        GROUP BY workspace_id, day
     ),
     rolled_agent_uses AS (
       SELECT COALESCE(sum(total), 0)::bigint AS total
         FROM rolled_agent_uses_by_day
     ),
     current_raw_agent_uses_by_day AS (
       SELECT workspace_id,
              (occurred_at AT TIME ZONE 'UTC')::date AS day,
              count(*)::bigint AS total
         FROM audit_events
        WHERE action = 'skill_retrieve'
          AND outcome = 'success'
        GROUP BY workspace_id, (occurred_at AT TIME ZONE 'UTC')::date
     ),
     unrolled_agent_uses AS (
       SELECT COALESCE(
                sum(
                  GREATEST(
                    raw.total - COALESCE(rolled.total, 0),
                    0
                  )
                ),
                0
              )::bigint AS total
         FROM current_raw_agent_uses_by_day raw
         LEFT JOIN rolled_agent_uses_by_day rolled
           ON rolled.workspace_id = raw.workspace_id
          AND rolled.day = raw.day
     )
     SELECT active_skills.total::text AS total_skills,
            (rolled_agent_uses.total + unrolled_agent_uses.total)::text
              AS agent_skill_uses
       FROM active_skills, rolled_agent_uses, unrolled_agent_uses`,
    [ALL_SKILLS_ROLLUP_ID],
  );
  const row = result.rows[0];
  if (!row) throw new Error("Public statistics query returned no rows");
  return {
    totalSkills: count(row.total_skills),
    agentSkillUses: count(row.agent_skill_uses),
  };
}
