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

export async function readPublicStats(
  pool: Pool,
  options: { readonly projected?: boolean } = {},
): Promise<PublicStats> {
  const result = await pool.query<PublicStatsRow>(
    options.projected
      ? `SELECT COALESCE(sum(counters.total_skills), 0)::text AS total_skills,
                COALESCE(sum(counters.agent_skill_uses), 0)::text AS agent_skill_uses
           FROM public_stats_counters counters`
      : `WITH active_skills AS (
       SELECT count(*)::bigint AS total
         FROM skills
        WHERE archived_at IS NULL
     )
     SELECT active_skills.total::text AS total_skills,
            COALESCE(sum(counters.agent_skill_uses), 0)::text AS agent_skill_uses
       FROM active_skills
       LEFT JOIN public_stats_counters counters ON true
      GROUP BY active_skills.total`,
  );
  const row = result.rows[0];
  if (!row) throw new Error("Public statistics query returned no rows");
  return {
    totalSkills: count(row.total_skills),
    agentSkillUses: count(row.agent_skill_uses),
  };
}
