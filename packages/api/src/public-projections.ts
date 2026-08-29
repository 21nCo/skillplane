import {
  DomainError,
  type SkillRecord,
  type SkillVersionRecord,
} from "@skillplane/domain";
import {
  retrieveBundleFile,
  type DownloadedSkillFile,
  type R2BundleRepository,
} from "@skillplane/storage";
import type { Pool } from "pg";

interface ProjectionRow {
  readonly workspace_id: string;
  readonly workspace_slug: string;
  readonly skill_id: string;
  readonly skill_slug: string;
  readonly version_id: string;
  readonly semantic_version: string;
  readonly digest: `sha256:${string}`;
  readonly object_key: string;
  readonly document: Record<string, unknown>;
  readonly published_at: Date;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function skill(row: ProjectionRow): SkillRecord & { readonly workspaceSlug: string } {
  const document = object(row.document.skill);
  return {
    ...document,
    id: row.skill_id,
    workspaceId: row.workspace_id,
    workspaceSlug: row.workspace_slug,
    slug: row.skill_slug,
    visibility: "public" as const,
    currentPublishedVersionId: row.version_id,
  } as unknown as SkillRecord & { readonly workspaceSlug: string };
}

function version(row: ProjectionRow): SkillVersionRecord {
  return {
    ...object(row.document.version),
    id: row.version_id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    semanticVersion: row.semantic_version,
    digest: row.digest,
    objectKey: row.object_key,
    status: "published" as const,
    publishedAt: row.published_at.toISOString(),
  } as unknown as SkillVersionRecord;
}

const SELECT = `SELECT workspace_id, workspace_slug, skill_id, skill_slug,
       version_id, semantic_version, digest, object_key, document, published_at
  FROM public_skill_projections`;

/** Read-only global discovery/retrieval projection used by canonical public hosts. */
export class PublicSkillProjectionService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2BundleRepository,
  ) {}

  private notFound(): never {
    throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
  }

  async discover(options: {
    readonly query: string;
    readonly tags: readonly string[];
    readonly limit?: number;
    readonly cursor?: string | null;
  }) {
    if (options.cursor) {
      throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
    }
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const query = options.query.trim();
    const result = await this.pool.query<ProjectionRow>(
      `SELECT DISTINCT ON (workspace_id, skill_id)
              workspace_id, workspace_slug, skill_id, skill_slug, version_id,
              semantic_version, digest, object_key, document, published_at
         FROM public_skill_projections
        WHERE state = 'published'
          AND ($1 = '' OR to_tsvector('english', search_text) @@
               websearch_to_tsquery('english', $1))
          AND ($2::text[] = '{}'::text[] OR
               ARRAY(SELECT jsonb_array_elements_text(
                 COALESCE(document->'skill'->'tags', '[]'::jsonb)
               )) @> $2::text[])
        ORDER BY workspace_id, skill_id, published_at DESC, version_id ASC
        LIMIT $3`,
      [query, [...new Set(options.tags)].sort(), limit],
    );
    return {
      skills: result.rows.map((row) => ({
        ...skill(row),
        currentVersionId: row.version_id,
        semanticVersion: row.semantic_version,
        digest: row.digest,
        archivedAt: null,
        score: "0",
      })),
      nextCursor: null,
    };
  }

  async getCurrent(workspaceSlug: string, skillSlug: string) {
    const result = await this.pool.query<ProjectionRow>(
      `${SELECT}
        WHERE workspace_slug = $1 AND skill_slug = $2 AND state = 'published'
        ORDER BY published_at DESC, version_id ASC
        LIMIT 1`,
      [workspaceSlug, skillSlug],
    );
    const row = result.rows[0];
    if (!row) return this.notFound();
    return { skill: skill(row), version: version(row) };
  }

  async listVersions(workspaceSlug: string, skillSlug: string, limit?: number) {
    const result = await this.pool.query<ProjectionRow>(
      `${SELECT}
        WHERE workspace_slug = $1 AND skill_slug = $2 AND state = 'published'
        ORDER BY published_at DESC, version_id ASC
        LIMIT $3`,
      [workspaceSlug, skillSlug, Math.max(1, Math.min(100, limit ?? 20))],
    );
    if (result.rows.length === 0) return this.notFound();
    return result.rows.map(version);
  }

  async retrieveFile(options: {
    readonly workspaceSlug: string;
    readonly skillSlug: string;
    readonly versionId: string;
    readonly digest: `sha256:${string}`;
    readonly path: string;
  }): Promise<DownloadedSkillFile> {
    const result = await this.pool.query<ProjectionRow>(
      `${SELECT}
        WHERE workspace_slug = $1 AND skill_slug = $2 AND version_id = $3
          AND digest = $4 AND state = 'published'
        LIMIT 1`,
      [options.workspaceSlug, options.skillSlug, options.versionId, options.digest],
    );
    const row = result.rows[0];
    if (!row) return this.notFound();
    try {
      return await retrieveBundleFile({
        repository: this.storage,
        objectKey: row.object_key,
        bundleDigest: row.digest,
        path: options.path,
      });
    } catch {
      throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
    }
  }
}
