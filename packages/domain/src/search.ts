import { stableJson } from "@skillplane/storage";
import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import type { Principal } from "./principal.js";
import type { SkillVisibility } from "./skills.js";
import {
  SKILL_ARCHIVE_FILTERS,
  SKILL_VISIBILITIES,
  type SkillArchiveFilter,
} from "./skills.js";

interface SearchCursorPayload {
  readonly version: 1;
  readonly filterHash: string;
  readonly score: string;
  readonly id: string;
  readonly expiresAt: number;
}

export interface SkillSearchResult {
  readonly id: string;
  readonly workspaceId: string;
  readonly workspaceSlug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: SkillVisibility;
  readonly currentVersionId: string;
  readonly semanticVersion: string;
  readonly digest: `sha256:${string}`;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly score: string;
}

export interface SkillSearchPage {
  readonly skills: readonly SkillSearchResult[];
  readonly nextCursor: string | null;
}

interface SearchRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly workspace_slug: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: string[];
  readonly visibility: SkillVisibility;
  readonly current_published_version_id: string;
  readonly semantic_version: string;
  readonly content_digest: `sha256:${string}`;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
  readonly score: string;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  try {
    const decoded = Uint8Array.from(atob(padded), (character) =>
      character.charCodeAt(0),
    );
    if (encodeBase64Url(decoded) !== value) {
      throw new Error("non-canonical base64url");
    }
    return decoded;
  } catch {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  if (secret.length < 32) {
    throw new DomainError(
      "CURSOR_INVALID",
      "Search cursor configuration is unavailable",
      500,
    );
  }
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function filterHash(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(stableJson(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return encodeBase64Url(new Uint8Array(digest));
}

async function signCursor(
  payload: SearchCursorPayload,
  secret: string,
): Promise<string> {
  const body = new TextEncoder().encode(stableJson(payload));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), body);
  return `${encodeBase64Url(body)}.${encodeBase64Url(new Uint8Array(signature))}`;
}

async function parseCursor(
  cursor: string,
  secret: string,
  expectedFilterHash: string,
  now: Date,
): Promise<SearchCursorPayload> {
  const parts = cursor.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  const body = decodeBase64Url(parts[0]);
  const signature = decodeBase64Url(parts[1]);
  const bodyInput = new Uint8Array(body.byteLength);
  bodyInput.set(body);
  const signatureInput = new Uint8Array(signature.byteLength);
  signatureInput.set(signature);
  const valid = await crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signatureInput,
    bodyInput,
  );
  if (!valid) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as { version?: unknown }).version !== 1 ||
    typeof (value as { filterHash?: unknown }).filterHash !== "string" ||
    typeof (value as { score?: unknown }).score !== "string" ||
    !/^\d+$/.test((value as { score: string }).score) ||
    typeof (value as { id?: unknown }).id !== "string" ||
    typeof (value as { expiresAt?: unknown }).expiresAt !== "number"
  ) {
    throw new DomainError("CURSOR_INVALID", "Search cursor is invalid", 400);
  }
  const payload = value as SearchCursorPayload;
  if (payload.expiresAt <= now.getTime()) {
    throw new DomainError("CURSOR_INVALID", "Search cursor has expired", 400);
  }
  if (payload.filterHash !== expectedFilterHash) {
    throw new DomainError(
      "CURSOR_FILTER_MISMATCH",
      "Search cursor does not match the current filters",
      400,
    );
  }
  return payload;
}

function normalizeSearchInput(options: {
  readonly query: string;
  readonly tags?: readonly string[];
  readonly visibility?: readonly SkillVisibility[];
  readonly archive?: SkillArchiveFilter;
  readonly limit?: number;
  readonly allowEmptyQuery?: boolean;
}): {
  readonly query: string;
  readonly tags: readonly string[];
  readonly visibility: readonly SkillVisibility[];
  readonly archive: SkillArchiveFilter;
  readonly limit: number;
} {
  const query = options.query.trim().replace(/\s+/g, " ");
  if ((!query && !options.allowEmptyQuery) || query.length > 500) {
    throw new DomainError(
      "VALIDATION_FAILED",
      options.allowEmptyQuery
        ? "Search query must be no more than 500 characters"
        : "Search query must be between 1 and 500 characters",
      400,
      { field: "q" },
    );
  }
  const tags = [...new Set((options.tags ?? []).map((tag) => tag.trim()))]
    .filter(Boolean)
    .sort();
  if (
    tags.length > 30 ||
    tags.some((tag) => tag.length > 80 || !/^[\p{L}\p{N}._:-]+$/u.test(tag))
  ) {
    throw new DomainError("VALIDATION_FAILED", "Search tags are invalid", 400, {
      field: "tags",
    });
  }
  const visibility = [
    ...new Set(
      (options.visibility ?? []).map((value) => {
        if (!(SKILL_VISIBILITIES as readonly string[]).includes(value)) {
          throw new DomainError(
            "SKILL_VISIBILITY_INVALID",
            "Skill visibility must be private, workspace, or public",
            400,
            { field: "visibility" },
          );
        }
        return value;
      }),
    ),
  ].sort();
  const archive = options.archive ?? "active";
  if (!(SKILL_ARCHIVE_FILTERS as readonly string[]).includes(archive)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Skill state must be active, archived, or all",
      400,
      { field: "state" },
    );
  }
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
  return { query, tags, visibility, archive, limit };
}

export class SkillSearchService {
  constructor(
    private readonly pool: Pool,
    private readonly cursorSecret: string,
  ) {}

  async search(options: {
    readonly query: string;
    readonly workspaceId?: string;
    readonly tags?: readonly string[];
    readonly visibility?: readonly SkillVisibility[];
    readonly archive?: SkillArchiveFilter;
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly principal?: Principal | null;
    readonly now?: Date;
  }): Promise<SkillSearchPage> {
    return this.executeSearch(options, false);
  }

  async discoverPublic(options: {
    readonly query?: string;
    readonly tags?: readonly string[];
    readonly limit?: number;
    readonly cursor?: string | null;
    readonly now?: Date;
  }): Promise<SkillSearchPage> {
    return this.executeSearch(
      {
        query: options.query ?? "",
        visibility: ["public"],
        archive: "active",
        principal: null,
        ...(options.tags ? { tags: options.tags } : {}),
        ...(options.limit !== undefined ? { limit: options.limit } : {}),
        ...(options.cursor !== undefined ? { cursor: options.cursor } : {}),
        ...(options.now ? { now: options.now } : {}),
      },
      true,
    );
  }

  private async executeSearch(
    options: {
      readonly query: string;
      readonly workspaceId?: string;
      readonly tags?: readonly string[];
      readonly visibility?: readonly SkillVisibility[];
      readonly archive?: SkillArchiveFilter;
      readonly limit?: number;
      readonly cursor?: string | null;
      readonly principal?: Principal | null;
      readonly now?: Date;
    },
    allowEmptyQuery: boolean,
  ): Promise<SkillSearchPage> {
    if (options.principal) authorize(options.principal, "skills:read");
    if (
      options.principal &&
      options.workspaceId &&
      options.workspaceId !== options.principal.workspaceId
    ) {
      throw new DomainError("NOT_FOUND", "Workspace resource was not found", 404);
    }
    const normalized = normalizeSearchInput({ ...options, allowEmptyQuery });
    const scope = options.principal
      ? `workspace:${options.principal.workspaceId}`
      : options.workspaceId
        ? `public-workspace:${options.workspaceId}`
        : "public";
    const digest = await filterHash({
      query: normalized.query,
      tags: normalized.tags,
      visibility: normalized.visibility,
      archive: normalized.archive,
      scope,
    });
    const now = options.now ?? new Date();
    const cursor = options.cursor
      ? await parseCursor(options.cursor, this.cursorSecret, digest, now)
      : null;
    const document = options.principal
      ? "workspace_search_document"
      : "public_search_document";
    const authorization = options.principal
      ? `skill.workspace_id = $1
         AND (
           ($8::text = 'active' AND skill.archived_at IS NULL)
           OR ($8::text = 'archived' AND skill.archived_at IS NOT NULL)
           OR $8::text = 'all'
         )`
      : `($1::text IS NULL OR skill.workspace_id = $1)
         AND skill.visibility = 'public'
         AND skill.archived_at IS NULL
         AND skill.current_published_version_id IS NOT NULL`;
    const workspaceId = options.principal?.workspaceId ?? options.workspaceId ?? null;
    const result = await this.pool.query<SearchRow>(
      `WITH authorized AS MATERIALIZED (
         SELECT skill.id, skill.workspace_id, workspace.slug AS workspace_slug,
                skill.slug, skill.name, skill.description, skill.tags,
                skill.visibility, skill.current_published_version_id,
                version.semantic_version, version.content_digest,
                skill.archived_at, skill.created_at, skill.updated_at,
                skill.${document} AS document
           FROM skills skill
           JOIN workspaces workspace ON workspace.id = skill.workspace_id
           JOIN skill_versions version
             ON version.id = skill.current_published_version_id
          WHERE ${authorization}
            AND ($2::text[] = '{}'::text[] OR skill.tags @> $2::text[])
            AND (
              cardinality($7::text[]) = 0
              OR skill.visibility = ANY($7::text[])
            )
       ),
       ranked AS MATERIALIZED (
         SELECT authorized.*,
                CASE
                  WHEN $3::text = '' THEN 0::bigint
                  ELSE round(
                    ts_rank_cd(
                      authorized.document,
                      websearch_to_tsquery('simple', $3)
                    ) * 1000000000
                  )::bigint
                END AS score
           FROM authorized
          WHERE (
            $3::text = ''
            OR authorized.document @@ websearch_to_tsquery('simple', $3)
          )
       )
       SELECT id, workspace_id, workspace_slug, slug, name, description, tags,
              visibility, current_published_version_id, semantic_version,
              content_digest, archived_at, created_at, updated_at, score::text
         FROM ranked
        WHERE (
          $4::bigint IS NULL
          OR score < $4::bigint
          OR (score = $4::bigint AND id > $5::text)
        )
        ORDER BY score DESC, id ASC
        LIMIT $6`,
      [
        workspaceId,
        normalized.tags,
        normalized.query,
        cursor?.score ?? null,
        cursor?.id ?? null,
        normalized.limit + 1,
        normalized.visibility,
        ...(options.principal ? [normalized.archive] : []),
      ],
    );
    const hasNext = result.rows.length > normalized.limit;
    const pageRows = result.rows.slice(0, normalized.limit);
    const skills = pageRows.map((row): SkillSearchResult => ({
      id: row.id,
      workspaceId: row.workspace_id,
      workspaceSlug: row.workspace_slug,
      slug: row.slug,
      name: row.name,
      description: row.description,
      tags: row.tags,
      visibility: row.visibility,
      currentVersionId: row.current_published_version_id,
      semanticVersion: row.semantic_version,
      digest: row.content_digest,
      archivedAt: row.archived_at?.toISOString() ?? null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      score: row.score,
    }));
    const boundary = hasNext ? skills.at(-1) : undefined;
    return {
      skills,
      nextCursor: boundary
        ? await signCursor(
            {
              version: 1,
              filterHash: digest,
              score: boundary.score,
              id: boundary.id,
              expiresAt: now.getTime() + 15 * 60 * 1000,
            },
            this.cursorSecret,
          )
        : null,
    };
  }
}
