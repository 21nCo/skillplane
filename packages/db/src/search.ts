import type { Pool } from "pg";

export interface SkillSearchResult {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly rank: number;
}

export async function searchSkills(
  pool: Pool,
  workspaceId: string,
  query: string,
  limit = 20,
): Promise<readonly SkillSearchResult[]> {
  const normalized = query.trim();
  if (!normalized || normalized.length > 500) {
    return [];
  }
  const boundedLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  const result = await pool.query<SkillSearchResult>(
    `SELECT id, slug, name, description,
            ts_rank(
              skillplane_skill_search_document(name, description, tags),
              plainto_tsquery('simple', $2)
            )::float8 AS rank
       FROM skills
      WHERE workspace_id = $1
        AND archived_at IS NULL
        AND skillplane_skill_search_document(name, description, tags)
            @@ plainto_tsquery('simple', $2)
      ORDER BY rank DESC, id ASC
      LIMIT $3`,
    [workspaceId, normalized, boundedLimit],
  );
  return result.rows;
}
