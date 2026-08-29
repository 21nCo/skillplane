import {
  BundleValidationError,
  StorageError,
  canonicalizeBundle,
  stableJson,
  type BundleManifest,
  type R2BundleRepository,
} from "@skillplane/storage";
import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import {
  IdempotencyStore,
  hashIdempotentRequest,
  type IdempotencyIdentity,
} from "./idempotency.js";
import { principalAuditActor, type Principal } from "./principal.js";
import {
  enqueueCurrentSkillProjection,
  enqueuePublishedSkillProjection,
  enqueueSkillCountProjection,
} from "./projection-events.js";
import { withDomainTransaction as withTransaction } from "./transactions.js";
import {
  insertMutationAudit,
  mutationAttribution,
  type MutationAuditContext,
} from "./mutation-audit.js";

export const SKILL_VISIBILITIES = ["private", "workspace", "public"] as const;
export type SkillVisibility = (typeof SKILL_VISIBILITIES)[number];
export const SKILL_ARCHIVE_FILTERS = ["active", "archived", "all"] as const;
export type SkillArchiveFilter = (typeof SKILL_ARCHIVE_FILTERS)[number];

export interface SkillRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly visibility: SkillVisibility;
  readonly currentPublishedVersionId: string | null;
  readonly currentSemanticVersion: string | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SkillVersionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly revision: number;
  readonly semanticVersion: string | null;
  readonly status: "draft" | "pending_review" | "published" | "rejected";
  readonly baseVersionId: string | null;
  readonly proposedBump: "patch" | "minor" | "major" | null;
  readonly source: "human" | "agent_amendment" | "import";
  readonly digest: `sha256:${string}`;
  readonly objectKey: string;
  readonly byteSize: number;
  readonly manifest: BundleManifest;
  readonly learningMetadata: Readonly<object>;
  readonly amendmentOperations: readonly Readonly<object>[];
  readonly callerDeclaration: Readonly<object>;
  readonly policyDecision: Readonly<object>;
  readonly changeSummary: string;
  readonly createdByActorType: "user" | "service_principal" | "system";
  readonly createdByActorId: string;
  readonly createdByAgent: string | null;
  readonly createdByModel: string | null;
  readonly createdForUserId: string | null;
  readonly publishedAt: string | null;
  readonly createdAt: string;
}

export interface SkillListPage {
  readonly skills: readonly SkillRecord[];
  readonly nextCursor: string | null;
}

interface SkillListCursor {
  readonly version: 1;
  readonly updatedAt: string;
  readonly id: string;
  readonly archive: SkillArchiveFilter;
  readonly visibility: readonly SkillVisibility[];
}

interface SkillRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string;
  readonly tags: string[];
  readonly visibility: string;
  readonly current_published_version_id: string | null;
  readonly semantic_version: string | null;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

export function parseSkillVisibility(value: unknown): SkillVisibility {
  if (
    typeof value !== "string" ||
    !(SKILL_VISIBILITIES as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "SKILL_VISIBILITY_INVALID",
      "Skill visibility must be private, workspace, or public",
      400,
      { field: "visibility" },
    );
  }
  return value as SkillVisibility;
}

export function parseSkillArchiveFilter(value: unknown): SkillArchiveFilter {
  if (
    typeof value !== "string" ||
    !(SKILL_ARCHIVE_FILTERS as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Skill state must be active, archived, or all",
      400,
      { field: "state" },
    );
  }
  return value as SkillArchiveFilter;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new DomainError("CURSOR_INVALID", "Skill cursor is invalid", 400);
  }
  const padded = value
    .replaceAll("-", "+")
    .replaceAll("_", "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    if (encodeBase64Url(bytes) !== value) throw new Error("non-canonical cursor");
    return bytes;
  } catch {
    throw new DomainError("CURSOR_INVALID", "Skill cursor is invalid", 400);
  }
}

function normalizeVisibilityFilter(
  values: readonly SkillVisibility[] | undefined,
): readonly SkillVisibility[] {
  return [...new Set((values ?? []).map(parseSkillVisibility))].sort();
}

function encodeListCursor(cursor: SkillListCursor): string {
  return encodeBase64Url(new TextEncoder().encode(stableJson(cursor)));
}

function parseListCursor(
  value: string,
  archive: SkillArchiveFilter,
  visibility: readonly SkillVisibility[],
): SkillListCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(value)),
    );
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError("CURSOR_INVALID", "Skill cursor is invalid", 400);
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    (parsed as { version?: unknown }).version !== 1 ||
    typeof (parsed as { updatedAt?: unknown }).updatedAt !== "string" ||
    !Number.isFinite(Date.parse((parsed as { updatedAt: string }).updatedAt)) ||
    typeof (parsed as { id?: unknown }).id !== "string" ||
    !(SKILL_ARCHIVE_FILTERS as readonly unknown[]).includes(
      (parsed as { archive?: unknown }).archive,
    ) ||
    !Array.isArray((parsed as { visibility?: unknown }).visibility)
  ) {
    throw new DomainError("CURSOR_INVALID", "Skill cursor is invalid", 400);
  }
  const cursor = parsed as SkillListCursor;
  if (
    cursor.archive !== archive ||
    stableJson(cursor.visibility) !== stableJson(visibility)
  ) {
    throw new DomainError(
      "CURSOR_FILTER_MISMATCH",
      "Skill cursor does not match the current filters",
      400,
    );
  }
  return cursor;
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

function safeSkill(row: SkillRow): SkillRecord {
  if (
    !(SKILL_VISIBILITIES as readonly string[]).includes(row.visibility) ||
    !Array.isArray(row.tags)
  ) {
    throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
  }
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    tags: row.tags,
    visibility: row.visibility as SkillVisibility,
    currentPublishedVersionId: row.current_published_version_id,
    currentSemanticVersion: row.semantic_version,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function normalizeExpectedUpdatedAt(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "expectedUpdatedAt must be an ISO 8601 timestamp",
      400,
      { field: "expectedUpdatedAt" },
    );
  }
  return new Date(timestamp).toISOString();
}

function assertExpectedUpdatedAt(
  row: SkillRow,
  expectedUpdatedAt: string | undefined,
): void {
  if (
    expectedUpdatedAt !== undefined &&
    row.updated_at.toISOString() !== expectedUpdatedAt
  ) {
    throw new DomainError(
      "SKILL_METADATA_CONFLICT",
      "Skill metadata changed after it was read",
      409,
      { currentUpdatedAt: row.updated_at.toISOString() },
    );
  }
}

function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505" &&
    "constraint" in error &&
    error.constraint === constraint
  );
}

export function mapSkillInfrastructureError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  if (error instanceof BundleValidationError) {
    throw new DomainError(error.code, error.message, 400);
  }
  if (error instanceof StorageError) {
    throw new DomainError(error.code, error.message, 503);
  }
  throw error;
}

async function releaseFailedClaim(
  idempotency: IdempotencyStore,
  identity: IdempotencyIdentity,
): Promise<void> {
  await idempotency.release(identity).catch(() => undefined);
}

export class SkillService {
  readonly idempotency: IdempotencyStore;

  constructor(
    readonly pool: Pool,
    readonly storage: R2BundleRepository,
    private readonly controlPool: Pool = pool,
  ) {
    this.idempotency = new IdempotencyStore(pool);
  }

  async create(options: {
    readonly workspaceId: string;
    readonly principal: Principal;
    readonly archiveBytes: Uint8Array;
    readonly visibility: SkillVisibility;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly fencingEpoch?: number;
    readonly auditContext?: MutationAuditContext;
  }): Promise<{ readonly skill: SkillRecord; readonly version: SkillVersionRecord }> {
    if (options.principal.workspaceId !== options.workspaceId) {
      throw new DomainError("SKILL_NOT_FOUND", "Workspace resource was not found", 404);
    }
    authorize(options.principal, "skills:write");
    const visibility = parseSkillVisibility(options.visibility);
    let canonical;
    try {
      canonical = await canonicalizeBundle(options.archiveBytes);
    } catch (error) {
      return mapSkillInfrastructureError(error);
    }
    const requestHash = await hashIdempotentRequest({
      operation: "skill.create",
      workspaceId: options.workspaceId,
      visibility,
      bundleDigest: canonical.digest,
      skill: canonical.skill,
    });
    const claim = await this.idempotency.claim<{
      skill: SkillRecord;
      version: SkillVersionRecord;
    }>({
      workspaceId: options.workspaceId,
      principal: options.principal,
      operation: "skill.create",
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody;

    const skillId = id("skill");
    const versionId = id("skill-version");
    let stored: Awaited<ReturnType<R2BundleRepository["putCanonicalBundle"]>> | null =
      null;
    try {
      const storedBundle = await this.storage.putCanonicalBundle(
        options.workspaceId,
        skillId,
        canonical.digest,
        canonical.bytes,
      );
      stored = storedBundle;
      const skillMarkdown = canonical.files.get("SKILL.md");
      if (!skillMarkdown) {
        throw new DomainError(
          "SKILL_BUNDLE_INVALID",
          "Canonical bundle is missing SKILL.md",
          400,
        );
      }
      const actor = principalAuditActor(options.principal);
      const attribution = mutationAttribution(options.auditContext);
      const response = await withTransaction(
        this.pool,
        options.requestId,
        async ({ client }) => {
          await client.query(
            `INSERT INTO skills
               (id, workspace_id, slug, name, description, tags, visibility,
                next_revision, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, 2, $8)`,
            [
              skillId,
              options.workspaceId,
              canonical.skill.slug,
              canonical.skill.name,
              canonical.skill.description,
              canonical.skill.tags,
              visibility,
              options.principal.kind === "user"
                ? options.principal.userId
                : (options.principal.delegatedUserId ?? null),
            ],
          );
          await client.query(
            `INSERT INTO skill_versions
               (id, workspace_id, skill_id, revision, semantic_version, status,
                source, content_digest, r2_object_key, bundle_byte_size,
                manifest, learning_metadata, change_summary,
                created_by_actor_type, created_by_actor_id, created_by_agent,
                created_by_model, created_for_user_id, published_at)
             VALUES (
               $1, $2, $3, 1, '1.0.0', 'published', $4, $5, $6, $7,
               $8, '{}'::jsonb, 'Initial published version', $9, $10, $11,
               $12, $13, now()
             )`,
            [
              versionId,
              options.workspaceId,
              skillId,
              options.principal.kind === "user" ? "human" : "import",
              canonical.digest,
              storedBundle.key,
              storedBundle.byteSize,
              canonical.manifest,
              actor.actorType,
              actor.actorId,
              attribution.agent,
              attribution.model,
              options.principal.kind === "user"
                ? options.principal.userId
                : (options.principal.delegatedUserId ?? null),
            ],
          );
          const fileIds = canonical.manifest.files.map(() => id("skill-file"));
          await client.query(
            `INSERT INTO skill_version_files
               (id, workspace_id, skill_version_id, path, content_type,
                byte_size, sha256, r2_object_key)
             SELECT *
             FROM unnest(
               $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
               $6::bigint[], $7::text[], $8::text[]
             )`,
            [
              fileIds,
              canonical.manifest.files.map(() => options.workspaceId),
              canonical.manifest.files.map(() => versionId),
              canonical.manifest.files.map((file) => file.path),
              canonical.manifest.files.map((file) => file.mediaType),
              canonical.manifest.files.map((file) => file.byteSize),
              canonical.manifest.files.map((file) => file.sha256),
              canonical.manifest.files.map(() => storedBundle.key),
            ],
          );
          await client.query(
            `UPDATE skills
                SET current_published_version_id = $2,
                    published_search_text = $3,
                    updated_at = now()
              WHERE id = $1`,
            [
              skillId,
              versionId,
              new TextDecoder("utf-8", { fatal: true }).decode(skillMarkdown),
            ],
          );
          await insertMutationAudit(client, options.principal, options.auditContext, {
            eventType: "skill.created",
            action: "skills:write",
            requestId: options.requestId,
            resourceType: "skill",
            resourceId: skillId,
            skillId,
            versionId,
            metadata: {
              revision: 1,
              semanticVersion: "1.0.0",
              digest: canonical.digest,
              visibility,
            },
          });
          const timestamps = await client.query<{
            skill_created_at: Date;
            skill_updated_at: Date;
            version_created_at: Date;
            version_published_at: Date;
          }>(
            `SELECT skill.created_at AS skill_created_at,
                    skill.updated_at AS skill_updated_at,
                    version.created_at AS version_created_at,
                    version.published_at AS version_published_at
               FROM skills skill
               JOIN skill_versions version
                 ON version.id = skill.current_published_version_id
              WHERE skill.id = $1 AND skill.workspace_id = $2`,
            [skillId, options.workspaceId],
          );
          const persisted = timestamps.rows[0];
          if (!persisted) {
            throw new DomainError(
              "SKILL_NOT_FOUND",
              "Created skill could not be read",
              500,
            );
          }
          const responseBody = {
            skill: {
              id: skillId,
              workspaceId: options.workspaceId,
              slug: canonical.skill.slug,
              name: canonical.skill.name,
              description: canonical.skill.description,
              tags: canonical.skill.tags,
              visibility,
              currentPublishedVersionId: versionId,
              currentSemanticVersion: "1.0.0",
              archivedAt: null,
              createdAt: persisted.skill_created_at.toISOString(),
              updatedAt: persisted.skill_updated_at.toISOString(),
            } satisfies SkillRecord,
            version: {
              id: versionId,
              workspaceId: options.workspaceId,
              skillId,
              revision: 1,
              semanticVersion: "1.0.0",
              status: "published",
              baseVersionId: null,
              proposedBump: null,
              source: options.principal.kind === "user" ? "human" : "import",
              digest: canonical.digest,
              objectKey: storedBundle.key,
              byteSize: storedBundle.byteSize,
              manifest: canonical.manifest,
              learningMetadata: {},
              amendmentOperations: [],
              callerDeclaration: {},
              policyDecision: {},
              changeSummary: "Initial published version",
              createdByActorType: actor.actorType,
              createdByActorId: actor.actorId,
              createdByAgent: attribution.agent,
              createdByModel: attribution.model,
              createdForUserId:
                options.principal.kind === "user"
                  ? options.principal.userId
                  : (options.principal.delegatedUserId ?? null),
              publishedAt: persisted.version_published_at.toISOString(),
              createdAt: persisted.version_created_at.toISOString(),
            } satisfies SkillVersionRecord,
          };
          if (responseBody.skill.visibility === "public") {
            await enqueuePublishedSkillProjection(client, {
              skill: responseBody.skill,
              version: responseBody.version,
              searchText: new TextDecoder("utf-8", { fatal: true }).decode(
                skillMarkdown,
              ),
              fencingEpoch: options.fencingEpoch,
            });
          }
          await enqueueSkillCountProjection(client, {
            workspaceId: options.workspaceId,
            delta: 1,
            fencingEpoch: options.fencingEpoch,
          });
          await this.idempotency.complete(client, claim.identity, 201, responseBody);
          return responseBody;
        },
      );
      return response;
    } catch (error) {
      await releaseFailedClaim(this.idempotency, claim.identity);
      if (stored) {
        await this.storage
          .deleteIfUnreferenced(stored.key, async (key) => {
            const result = await this.pool.query(
              "SELECT 1 FROM skill_versions WHERE r2_object_key = $1 LIMIT 1",
              [key],
            );
            return result.rowCount === 1;
          })
          .catch(() => undefined);
      }
      if (isUniqueViolation(error, "skills_workspace_slug_unique")) {
        throw new DomainError(
          "SKILL_SLUG_CONFLICT",
          "That skill slug already exists in this workspace",
          409,
          { field: "slug" },
        );
      }
      return mapSkillInfrastructureError(error);
    }
  }

  async list(options: {
    readonly workspaceId: string;
    readonly principal: Principal;
    readonly includeArchived?: boolean;
    readonly limit?: number;
  }): Promise<readonly SkillRecord[]> {
    const page = await this.listPage({
      workspaceId: options.workspaceId,
      principal: options.principal,
      archive: options.includeArchived ? "all" : "active",
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
    });
    return page.skills;
  }

  async listPage(options: {
    readonly workspaceId: string;
    readonly principal: Principal;
    readonly archive?: SkillArchiveFilter;
    readonly visibility?: readonly SkillVisibility[];
    readonly cursor?: string | null;
    readonly limit?: number;
  }): Promise<SkillListPage> {
    if (options.principal.workspaceId !== options.workspaceId) {
      throw new DomainError("SKILL_NOT_FOUND", "Workspace resource was not found", 404);
    }
    authorize(options.principal, "skills:read");
    const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 20)));
    const archive = parseSkillArchiveFilter(options.archive ?? "active");
    const visibility = normalizeVisibilityFilter(options.visibility);
    const cursor = options.cursor
      ? parseListCursor(options.cursor, archive, visibility)
      : null;
    const result = await this.pool.query<SkillRow>(
      `SELECT s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
              s.visibility, s.current_published_version_id,
              version.semantic_version, s.archived_at, s.created_at, s.updated_at
         FROM skills s
         LEFT JOIN skill_versions version
           ON version.id = s.current_published_version_id
        WHERE s.workspace_id = $1
          AND (
            ($2::text = 'active' AND s.archived_at IS NULL)
            OR ($2::text = 'archived' AND s.archived_at IS NOT NULL)
            OR $2::text = 'all'
          )
          AND (
            cardinality($3::text[]) = 0
            OR s.visibility = ANY($3::text[])
          )
          AND (
            $4::timestamptz IS NULL
            OR s.updated_at < $4::timestamptz
            OR (s.updated_at = $4::timestamptz AND s.id > $5::text)
          )
        ORDER BY s.updated_at DESC, s.id ASC
        LIMIT $6`,
      [
        options.workspaceId,
        archive,
        visibility,
        cursor?.updatedAt ?? null,
        cursor?.id ?? null,
        limit + 1,
      ],
    );
    const hasNext = result.rows.length > limit;
    const skills = result.rows.slice(0, limit).map(safeSkill);
    const boundary = hasNext ? skills.at(-1) : undefined;
    return {
      skills,
      nextCursor: boundary
        ? encodeListCursor({
            version: 1,
            updatedAt: boundary.updatedAt,
            id: boundary.id,
            archive,
            visibility,
          })
        : null,
    };
  }

  async getBySlug(options: {
    readonly workspaceId: string;
    readonly skillSlug: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<SkillRecord> {
    if (options.principal.workspaceId !== options.workspaceId) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    authorize(options.principal, "skills:read");
    const result = await this.pool.query<SkillRow>(
      `SELECT s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
              s.visibility, s.current_published_version_id,
              version.semantic_version, s.archived_at, s.created_at, s.updated_at
         FROM skills s
         LEFT JOIN skill_versions version
           ON version.id = s.current_published_version_id
        WHERE s.workspace_id = $1 AND s.slug = $2
          AND ($3::boolean OR s.archived_at IS NULL)
        LIMIT 1`,
      [options.workspaceId, options.skillSlug, options.allowArchived ?? false],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    return safeSkill(row);
  }

  async getPublicBySlug(options: {
    readonly workspaceSlug: string;
    readonly skillSlug: string;
  }): Promise<SkillRecord> {
    const workspace = await this.controlPool.query<{ id: string }>(
      "SELECT id FROM workspaces WHERE slug = $1 LIMIT 1",
      [options.workspaceSlug],
    );
    const workspaceId = workspace.rows[0]?.id;
    if (!workspaceId) {
      throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    }
    const result = await this.pool.query<SkillRow>(
      `SELECT s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
              s.visibility, s.current_published_version_id,
              version.semantic_version, s.archived_at, s.created_at, s.updated_at
         FROM skills s
         JOIN skill_versions version
           ON version.id = s.current_published_version_id
        WHERE s.workspace_id = $1 AND s.slug = $2
          AND s.visibility = 'public'
          AND s.archived_at IS NULL
          AND version.status = 'published'
        LIMIT 1`,
      [workspaceId, options.skillSlug],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    return safeSkill(row);
  }

  async get(options: {
    readonly skillId: string;
    readonly principal?: Principal | null;
    readonly allowArchived?: boolean;
  }): Promise<SkillRecord> {
    const result = await this.pool.query<SkillRow>(
      `SELECT s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
              s.visibility, s.current_published_version_id,
              version.semantic_version, s.archived_at, s.created_at, s.updated_at
         FROM skills s
         LEFT JOIN skill_versions version
           ON version.id = s.current_published_version_id
        WHERE s.id = $1
          AND (
            ($2::text IS NOT NULL AND s.workspace_id = $2)
            OR (
              $2::text IS NULL
              AND s.visibility = 'public'
              AND s.current_published_version_id IS NOT NULL
              AND s.archived_at IS NULL
            )
          )
          AND ($3::boolean OR s.archived_at IS NULL)
        LIMIT 1`,
      [
        options.skillId,
        options.principal?.workspaceId ?? null,
        options.allowArchived ?? false,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
    if (options.principal?.workspaceId === row.workspace_id) {
      authorize(options.principal, "skills:read");
    }
    return safeSkill(row);
  }

  async setVisibility(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly visibility: SkillVisibility;
    readonly expectedUpdatedAt?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly fencingEpoch?: number;
    readonly auditContext?: MutationAuditContext;
  }): Promise<SkillRecord> {
    authorize(options.principal, "skills:write");
    const visibility = parseSkillVisibility(options.visibility);
    const expectedUpdatedAt = normalizeExpectedUpdatedAt(options.expectedUpdatedAt);
    const requestHash = await hashIdempotentRequest({
      operation: "skill.visibility",
      skillId: options.skillId,
      visibility,
      expectedUpdatedAt: expectedUpdatedAt ?? null,
    });
    const claim = await this.idempotency.claim<{ skill: SkillRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `skill.visibility:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.skill;
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const current = await client.query<SkillRow>(
          `SELECT s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
                  s.visibility, s.current_published_version_id,
                  version.semantic_version, s.archived_at, s.created_at,
                  s.updated_at
             FROM skills s
             LEFT JOIN skill_versions version
               ON version.id = s.current_published_version_id
            WHERE s.id = $1 AND s.workspace_id = $2
            FOR UPDATE OF s`,
          [options.skillId, options.principal.workspaceId],
        );
        const previous = current.rows[0];
        if (!previous) {
          throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
        }
        assertExpectedUpdatedAt(previous, expectedUpdatedAt);
        const result = await client.query<SkillRow>(
          `UPDATE skills s
              SET visibility = $3,
                  updated_at = GREATEST(
                    clock_timestamp(),
                    s.updated_at + interval '1 millisecond'
                  )
             FROM skill_versions version
            WHERE s.id = $1 AND s.workspace_id = $2
              AND version.id = s.current_published_version_id
            RETURNING s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
                      s.visibility, s.current_published_version_id,
                      version.semantic_version, s.archived_at, s.created_at,
                      s.updated_at`,
          [options.skillId, options.principal.workspaceId, visibility],
        );
        const row = result.rows[0];
        if (!row) throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
        await insertMutationAudit(client, options.principal, options.auditContext, {
          eventType: "skill.visibility_changed",
          action: "skills:write",
          requestId: options.requestId,
          resourceType: "skill",
          resourceId: options.skillId,
          skillId: options.skillId,
          metadata: {
            visibility,
            previousUpdatedAt: previous.updated_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          },
        });
        const skill = safeSkill(row);
        await enqueueCurrentSkillProjection(client, {
          skill,
          fencingEpoch: options.fencingEpoch,
        });
        await this.idempotency.complete(client, claim.identity, 200, { skill });
        return skill;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
      throw error;
    }
  }

  async setArchived(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly archived: boolean;
    readonly expectedUpdatedAt?: string;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly fencingEpoch?: number;
    readonly auditContext?: MutationAuditContext;
  }): Promise<SkillRecord> {
    authorize(options.principal, "skills:write");
    const expectedUpdatedAt = normalizeExpectedUpdatedAt(options.expectedUpdatedAt);
    const requestHash = await hashIdempotentRequest({
      operation: options.archived ? "skill.archive" : "skill.restore",
      skillId: options.skillId,
      expectedUpdatedAt: expectedUpdatedAt ?? null,
    });
    const claim = await this.idempotency.claim<{ skill: SkillRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `${options.archived ? "skill.archive" : "skill.restore"}:${
        options.skillId
      }`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.skill;
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const current = await client.query<SkillRow>(
          `SELECT s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
                  s.visibility, s.current_published_version_id,
                  version.semantic_version, s.archived_at, s.created_at,
                  s.updated_at
             FROM skills s
             LEFT JOIN skill_versions version
               ON version.id = s.current_published_version_id
            WHERE s.id = $1 AND s.workspace_id = $2
            FOR UPDATE OF s`,
          [options.skillId, options.principal.workspaceId],
        );
        const previous = current.rows[0];
        if (!previous) {
          throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
        }
        assertExpectedUpdatedAt(previous, expectedUpdatedAt);
        const result = await client.query<SkillRow>(
          `UPDATE skills s
            SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now())
                                   ELSE NULL END,
                updated_at = GREATEST(
                  clock_timestamp(),
                  s.updated_at + interval '1 millisecond'
                )
           FROM skill_versions version
          WHERE s.id = $1 AND s.workspace_id = $2
            AND version.id = s.current_published_version_id
          RETURNING s.id, s.workspace_id, s.slug, s.name, s.description, s.tags,
                    s.visibility, s.current_published_version_id,
                    version.semantic_version, s.archived_at, s.created_at,
                    s.updated_at`,
          [options.skillId, options.principal.workspaceId, options.archived],
        );
        const row = result.rows[0];
        if (!row) throw new DomainError("SKILL_NOT_FOUND", "Skill was not found", 404);
        await insertMutationAudit(client, options.principal, options.auditContext, {
          eventType: options.archived ? "skill.archived" : "skill.restored",
          action: "skills:write",
          requestId: options.requestId,
          resourceType: "skill",
          resourceId: options.skillId,
          skillId: options.skillId,
          metadata: {
            archived: options.archived,
            previousUpdatedAt: previous.updated_at.toISOString(),
            updatedAt: row.updated_at.toISOString(),
          },
        });
        const skill = safeSkill(row);
        await enqueueCurrentSkillProjection(client, {
          skill,
          fencingEpoch: options.fencingEpoch,
        });
        if (Boolean(previous.archived_at) !== options.archived) {
          await enqueueSkillCountProjection(client, {
            workspaceId: options.principal.workspaceId,
            delta: options.archived ? -1 : 1,
            fencingEpoch: options.fencingEpoch,
          });
        }
        await this.idempotency.complete(client, claim.identity, 200, { skill });
        return skill;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity).catch(() => undefined);
      throw error;
    }
  }
}
