import {
  DomainError,
  type SkillRecord,
  type SkillVersionRecord,
} from "@skillplane/domain";
import {
  BundlePathError,
  BundleValidationError,
  retrieveBundleFile,
  stableJson,
  StorageError,
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

interface RankedProjectionRow extends ProjectionRow {
  readonly score: string;
}

interface ProjectionCursor {
  readonly version: 1;
  readonly filterHash: string;
  readonly score: string;
  readonly id: string;
  readonly expiresAt: number;
}

function encode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  try {
    const bytes = Uint8Array.from(
      atob(
        value
          .replaceAll("-", "+")
          .replaceAll("_", "/")
          .padEnd(Math.ceil(value.length / 4) * 4, "="),
      ),
      (character) => character.charCodeAt(0),
    );
    if (encode(bytes) !== value) throw new Error("non-canonical");
    return bytes;
  } catch {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
}

function bufferSource(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new DomainError("CURSOR_INVALID", "Search is unavailable", 500);
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`skillplane-public-search\u0000${secret}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function projectionFilterHash(query: string, tags: readonly string[]) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson({ query, tags })),
  );
  return encode(new Uint8Array(digest));
}

async function signProjectionCursor(payload: ProjectionCursor, secret: string) {
  const body = new TextEncoder().encode(stableJson(payload));
  const signature = await crypto.subtle.sign("HMAC", await cursorKey(secret), body);
  return `${encode(body)}.${encode(new Uint8Array(signature))}`;
}

async function parseProjectionCursor(
  value: string,
  secret: string,
  expectedFilterHash: string,
): Promise<ProjectionCursor> {
  const [bodyValue, signatureValue, extra] = value.split(".");
  if (!bodyValue || !signatureValue || extra) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  const body = decode(bodyValue);
  const signature = decode(signatureValue);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await cursorKey(secret),
      bufferSource(signature),
      bufferSource(body),
    ))
  ) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { filterHash?: unknown }).filterHash !== "string" ||
    typeof (parsed as { score?: unknown }).score !== "string" ||
    !/^\d+$/u.test((parsed as { score: string }).score) ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    typeof (parsed as { expiresAt?: unknown }).expiresAt !== "number"
  ) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  const cursor = parsed as ProjectionCursor;
  if (cursor.expiresAt <= Date.now()) {
    throw new DomainError("CURSOR_INVALID", "Search cursor has expired", 400);
  }
  if (cursor.filterHash !== expectedFilterHash) {
    throw new DomainError(
      "CURSOR_FILTER_MISMATCH",
      "Search cursor does not match the current filters",
      400,
    );
  }
  return cursor;
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
  const document = object(row.document.version);
  const sourcePublishedAt =
    typeof document.publishedAt === "string" &&
    Number.isFinite(Date.parse(document.publishedAt))
      ? new Date(document.publishedAt).toISOString()
      : row.published_at.toISOString();
  return {
    ...document,
    id: row.version_id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    semanticVersion: row.semantic_version,
    digest: row.digest,
    objectKey: row.object_key,
    status: "published" as const,
    publishedAt: sourcePublishedAt,
  } as unknown as SkillVersionRecord;
}

export function mapPublicProjectionFileError(error: unknown): never {
  if (error instanceof Error && error.message === "SKILL_FILE_NOT_FOUND") {
    throw new DomainError("SKILL_FILE_NOT_FOUND", "Skill file was not found", 404);
  }
  if (error instanceof BundlePathError) {
    throw new DomainError(error.code, error.message, 400);
  }
  if (error instanceof StorageError) {
    throw new DomainError(error.code, error.message, 503);
  }
  if (
    error instanceof BundleValidationError ||
    (error instanceof Error && error.message === "SKILL_FILE_DIGEST_MISMATCH")
  ) {
    throw new DomainError(
      "R2_OBJECT_MISMATCH",
      "Published skill bundle failed integrity verification",
      503,
    );
  }
  throw error;
}

const SELECT = `SELECT workspace_id, workspace_slug, skill_id, skill_slug,
       version_id, semantic_version, digest, object_key, document, published_at
  FROM public_skill_projections`;

/** Read-only global discovery/retrieval projection used by canonical public hosts. */
export class PublicSkillProjectionService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: R2BundleRepository,
    private readonly cursorSecret: string,
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
    const limit = Math.max(1, Math.min(100, options.limit ?? 20));
    const query = options.query.trim();
    const tags = [...new Set(options.tags)].sort();
    const filterHash = await projectionFilterHash(query, tags);
    const cursor = options.cursor
      ? await parseProjectionCursor(options.cursor, this.cursorSecret, filterHash)
      : null;
    const result = await this.pool.query<RankedProjectionRow>(
      `WITH latest AS MATERIALIZED (
         SELECT DISTINCT ON (workspace_id, skill_id)
                workspace_id, workspace_slug, skill_id, skill_slug, version_id,
                semantic_version, digest, object_key, document, published_at,
                search_text
           FROM public_skill_projections
          WHERE state = 'published'
          ORDER BY workspace_id, skill_id, published_at DESC, version_id ASC
       ), ranked AS MATERIALIZED (
         SELECT latest.*,
                CASE WHEN $1::text = '' THEN 0::bigint ELSE round(
                  ts_rank_cd(
                    to_tsvector('english', search_text),
                    websearch_to_tsquery('english', $1)
                  ) * 1000000000
                )::bigint END AS score
           FROM latest
          WHERE ($1::text = '' OR to_tsvector('english', search_text) @@
                 websearch_to_tsquery('english', $1))
            AND ($2::text[] = '{}'::text[] OR
                 ARRAY(SELECT jsonb_array_elements_text(
                   COALESCE(document->'skill'->'tags', '[]'::jsonb)
                 )) @> $2::text[])
       )
       SELECT workspace_id, workspace_slug, skill_id, skill_slug, version_id,
              semantic_version, digest, object_key, document, published_at,
              score::text
         FROM ranked
        WHERE ($3::bigint IS NULL OR score < $3::bigint OR
               (score = $3::bigint AND skill_id > $4::text))
        ORDER BY score DESC, skill_id ASC
        LIMIT $5`,
      [query, tags, cursor?.score ?? null, cursor?.id ?? null, limit + 1],
    );
    const hasNext = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const boundary = hasNext ? rows.at(-1) : undefined;
    return {
      skills: rows.map((row) => ({
        ...skill(row),
        currentVersionId: row.version_id,
        semanticVersion: row.semantic_version,
        digest: row.digest,
        archivedAt: null,
        score: row.score,
      })),
      nextCursor: boundary
        ? await signProjectionCursor(
            {
              version: 1,
              filterHash,
              score: boundary.score,
              id: boundary.skill_id,
              expiresAt: Date.now() + 15 * 60 * 1000,
            },
            this.cursorSecret,
          )
        : null,
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

  async getCurrentBySkillId(skillId: string) {
    const result = await this.pool.query<ProjectionRow>(
      `${SELECT}
        WHERE skill_id = $1 AND state = 'published'
        ORDER BY published_at DESC, version_id ASC
        LIMIT 1`,
      [skillId],
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
    } catch (error) {
      return mapPublicProjectionFileError(error);
    }
  }
}
