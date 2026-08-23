import type { Pool } from "pg";

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
     )
     SELECT active_skills.total::text AS total_skills,
            counters.agent_skill_uses::text AS agent_skill_uses
       FROM active_skills
       CROSS JOIN public_stats_counters counters
      WHERE counters.id = 'global'`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Public statistics query returned no rows");
  return {
    totalSkills: count(row.total_skills),
    agentSkillUses: count(row.agent_skill_uses),
  };
}
