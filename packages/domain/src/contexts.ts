import { stableJson } from "@skillplane/storage";
import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { withDomainTransaction as withTransaction } from "./transactions.js";

export const CONTEXT_TYPES = [
  "repository",
  "project",
  "customer",
  "environment",
  "custom",
] as const;
export type ContextType = (typeof CONTEXT_TYPES)[number];

export const CONTEXT_ARCHIVE_FILTERS = ["active", "archived", "all"] as const;
export type ContextArchiveFilter = (typeof CONTEXT_ARCHIVE_FILTERS)[number];

const CONTEXT_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const MAX_CONTEXTS_PER_SKILL = 100;
const MAX_KNOWLEDGE_BYTES = 512 * 1024;
const MAX_METADATA_BYTES = 32 * 1024;
const MAX_METADATA_DEPTH = 8;
const MAX_METADATA_KEYS = 200;

export interface ContextRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly skillId: string;
  readonly slug: string;
  readonly name: string;
  readonly type: ContextType;
  readonly externalReference: string | null;
  readonly description: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly currentKnowledgeRevisionId: string | null;
  readonly currentKnowledgeRevision: number | null;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextKnowledgeRevisionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly contextId: string;
  readonly revision: number;
  readonly baseRevisionId: string | null;
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly createdByActorType: "user" | "service_principal";
  readonly createdByActorId: string;
  readonly createdByAgent: string | null;
  readonly createdByModel: string | null;
  readonly createdForUserId: string | null;
  readonly createdAt: string;
}

export interface ContextCreateResult {
  readonly context: ContextRecord;
  readonly knowledge: ContextKnowledgeRevisionRecord;
}

interface ContextRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly skill_id: string;
  readonly slug: string;
  readonly name: string;
  readonly context_type: string;
  readonly external_reference: string | null;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly current_knowledge_revision_id: string | null;
  readonly current_knowledge_revision: number | null;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface KnowledgeRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly context_id: string;
  readonly revision: number;
  readonly base_revision_id: string | null;
  readonly knowledge: string;
  readonly body_digest: `sha256:${string}`;
  readonly learning_metadata: Record<string, unknown>;
  readonly created_by_actor_type: "user" | "service_principal";
  readonly created_by_actor_id: string;
  readonly created_by_agent: string | null;
  readonly created_by_model: string | null;
  readonly created_for_user_id: string | null;
  readonly created_at: Date;
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
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

function validateJsonValue(
  value: unknown,
  depth: number,
  count: { value: number },
): void {
  if (depth > MAX_METADATA_DEPTH) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Metadata cannot exceed 8 levels of nesting",
      400,
      { field: "metadata" },
    );
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Metadata numbers must be finite",
        400,
        { field: "metadata" },
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) validateJsonValue(entry, depth + 1, count);
    return;
  }
  if (typeof value !== "object") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Metadata must contain only JSON values",
      400,
      { field: "metadata" },
    );
  }
  for (const [key, entry] of Object.entries(value)) {
    if (!key || key.length > 200) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Metadata keys must be between 1 and 200 characters",
        400,
        { field: "metadata" },
      );
    }
    count.value += 1;
    if (count.value > MAX_METADATA_KEYS) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "Metadata cannot contain more than 200 keys",
        400,
        { field: "metadata" },
      );
    }
    validateJsonValue(entry, depth + 1, count);
  }
}

export function normalizeMetadata(
  value: unknown,
  field = "metadata",
): Readonly<Record<string, unknown>> {
  if (
    value === undefined ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    if (value === undefined || value === null) return {};
    throw new DomainError("VALIDATION_FAILED", `${field} must be a JSON object`, 400, {
      field,
    });
  }
  const normalized = value as Record<string, unknown>;
  validateJsonValue(normalized, 0, { value: 0 });
  if (
    new TextEncoder().encode(stableJson(normalized)).byteLength > MAX_METADATA_BYTES
  ) {
    throw new DomainError("VALIDATION_FAILED", `${field} cannot exceed 32 KiB`, 400, {
      field,
    });
  }
  return normalized;
}

export function normalizeContextSlug(value: unknown): string {
  const slug = typeof value === "string" ? value.trim() : "";
  if (slug.length > 120 || !CONTEXT_SLUG_PATTERN.test(slug)) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Context slug must use lowercase letters, numbers, and single hyphens",
      400,
      { field: "slug" },
    );
  }
  return slug;
}

export function normalizeContextName(value: unknown): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!name || name.length > 160) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Context name must be between 1 and 160 characters",
      400,
      { field: "name" },
    );
  }
  return name;
}

export function normalizeDescription(value: unknown): string {
  const description = typeof value === "string" ? value.trim() : "";
  if (description.length > 2_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Context description cannot exceed 2,000 characters",
      400,
      { field: "description" },
    );
  }
  return description;
}

export function normalizeExternalReference(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  const reference = typeof value === "string" ? value.trim() : "";
  if (!reference || reference.length > 2_000) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "External reference must be between 1 and 2,000 characters",
      400,
      { field: "externalReference" },
    );
  }
  return reference;
}

export function parseContextType(value: unknown): ContextType {
  if (
    typeof value !== "string" ||
    !(CONTEXT_TYPES as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `Context type must be one of ${CONTEXT_TYPES.join(", ")}`,
      400,
      { field: "type" },
    );
  }
  return value as ContextType;
}

export function parseContextArchiveFilter(value: unknown): ContextArchiveFilter {
  if (
    typeof value !== "string" ||
    !(CONTEXT_ARCHIVE_FILTERS as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Context state must be active, archived, or all",
      400,
      { field: "state" },
    );
  }
  return value as ContextArchiveFilter;
}

export function normalizeRevisionBody(
  value: unknown,
  options: { readonly field: string; readonly maxBytes: number },
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${options.field} must contain Markdown`,
      400,
      { field: options.field },
    );
  }
  if (new TextEncoder().encode(value).byteLength > options.maxBytes) {
    throw new DomainError(
      "VALIDATION_FAILED",
      `${options.field} exceeds its ${String(Math.floor(options.maxBytes / 1024))} KiB limit`,
      400,
      { field: options.field },
    );
  }
  return value;
}

export function normalizeKnowledge(value: unknown): string {
  return normalizeRevisionBody(value, {
    field: "knowledge",
    maxBytes: MAX_KNOWLEDGE_BYTES,
  });
}

export async function sha256TextDigest(value: string): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  const hex = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `sha256:${hex}`;
}

export function toContextRecord(row: ContextRow): ContextRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    skillId: row.skill_id,
    slug: row.slug,
    name: row.name,
    type: parseContextType(row.context_type),
    externalReference: row.external_reference,
    description: row.description,
    metadata: row.metadata,
    currentKnowledgeRevisionId: row.current_knowledge_revision_id,
    currentKnowledgeRevision: row.current_knowledge_revision,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function toContextKnowledgeRevisionRecord(
  row: KnowledgeRow,
): ContextKnowledgeRevisionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contextId: row.context_id,
    revision: row.revision,
    baseRevisionId: row.base_revision_id,
    body: row.knowledge,
    bodyDigest: row.body_digest,
    learningMetadata: row.learning_metadata,
    createdByActorType: row.created_by_actor_type,
    createdByActorId: row.created_by_actor_id,
    createdByAgent: row.created_by_agent,
    createdByModel: row.created_by_model,
    createdForUserId: row.created_for_user_id,
    createdAt: row.created_at.toISOString(),
  };
}

const contextSelect = `
  SELECT context.id, context.workspace_id, context.skill_id, context.slug,
         context.name, context.context_type, context.external_reference,
         context.description, context.metadata,
         context.current_knowledge_revision_id,
         current_knowledge.revision AS current_knowledge_revision,
         context.archived_at, context.created_at, context.updated_at
    FROM skill_contexts context
    LEFT JOIN context_knowledge_revisions current_knowledge
      ON current_knowledge.id = context.current_knowledge_revision_id
     AND current_knowledge.context_id = context.id`;

export class ContextService {
  constructor(
    readonly pool: Pool,
    readonly idempotency: IdempotencyStore,
  ) {}

  async list(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly archive?: ContextArchiveFilter;
  }): Promise<readonly ContextRecord[]> {
    authorize(options.principal, "contexts:read");
    const archive = parseContextArchiveFilter(options.archive ?? "active");
    const result = await this.pool.query<ContextRow>(
      `${contextSelect}
        JOIN skills skill
          ON skill.id = context.skill_id
         AND skill.workspace_id = context.workspace_id
       WHERE context.workspace_id = $1
         AND context.skill_id = $2
         AND ($3 = 'all'
           OR ($3 = 'active' AND context.archived_at IS NULL)
           OR ($3 = 'archived' AND context.archived_at IS NOT NULL))
       ORDER BY context.updated_at DESC, context.id`,
      [options.principal.workspaceId, options.skillId, archive],
    );
    if (result.rows.length === 0) {
      const skill = await this.pool.query(
        `SELECT 1 FROM skills WHERE id = $1 AND workspace_id = $2`,
        [options.skillId, options.principal.workspaceId],
      );
      if (skill.rowCount !== 1) {
        throw new DomainError(
          "CONTEXT_NOT_FOUND",
          "Skill contexts were not found",
          404,
        );
      }
    }
    return result.rows.map(toContextRecord);
  }

  async get(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<ContextRecord> {
    authorize(options.principal, "contexts:read");
    const result = await this.pool.query<ContextRow>(
      `${contextSelect}
       WHERE context.id = $1
         AND context.workspace_id = $2
         AND ($3::boolean OR context.archived_at IS NULL)`,
      [
        options.contextId,
        options.principal.workspaceId,
        options.allowArchived ?? false,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    return toContextRecord(row);
  }

  async getBySlug(options: {
    readonly skillId: string;
    readonly contextSlug: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<ContextRecord> {
    authorize(options.principal, "contexts:read");
    const slug = normalizeContextSlug(options.contextSlug);
    const result = await this.pool.query<ContextRow>(
      `${contextSelect}
       WHERE context.workspace_id = $1
         AND context.skill_id = $2
         AND context.slug = $3
         AND ($4::boolean OR context.archived_at IS NULL)`,
      [
        options.principal.workspaceId,
        options.skillId,
        slug,
        options.allowArchived ?? false,
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
    }
    return toContextRecord(row);
  }

  async create(options: {
    readonly skillId: string;
    readonly principal: Principal;
    readonly slug: string;
    readonly name: string;
    readonly type: ContextType;
    readonly externalReference?: string | null;
    readonly description?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly initialKnowledge: string;
    readonly learningMetadata?: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<ContextCreateResult> {
    authorize(options.principal, "contexts:write");
    const slug = normalizeContextSlug(options.slug);
    const name = normalizeContextName(options.name);
    const type = parseContextType(options.type);
    const externalReference = normalizeExternalReference(options.externalReference);
    const description = normalizeDescription(options.description);
    const metadata = normalizeMetadata(options.metadata);
    const knowledge = normalizeKnowledge(options.initialKnowledge);
    const learningMetadata = normalizeMetadata(
      options.learningMetadata,
      "learningMetadata",
    );
    const bodyDigest = await sha256TextDigest(knowledge);
    const requestHash = await hashIdempotentRequest({
      operation: "context.create",
      skillId: options.skillId,
      slug,
      name,
      type,
      externalReference,
      description,
      metadata,
      bodyDigest,
      learningMetadata,
    });
    const claim = await this.idempotency.claim<{
      context: ContextRecord;
      knowledge: ContextKnowledgeRevisionRecord;
    }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.create:${options.skillId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody;

    const contextId = id("context");
    const revisionId = id("context-knowledge");
    const actor = principalAuditActor(options.principal);
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const skill = await client.query<{ archived_at: Date | null }>(
          `SELECT archived_at
               FROM skills
              WHERE id = $1 AND workspace_id = $2
              FOR SHARE`,
          [options.skillId, options.principal.workspaceId],
        );
        const skillRow = skill.rows[0];
        if (!skillRow) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Skill was not found", 404);
        }
        if (skillRow.archived_at) {
          throw new DomainError(
            "SKILL_ARCHIVED",
            "Archived skills cannot receive contexts",
            409,
          );
        }
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
               FROM skill_contexts
              WHERE skill_id = $1`,
          [options.skillId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= MAX_CONTEXTS_PER_SKILL) {
          throw new DomainError(
            "CONTEXT_LIMIT_REACHED",
            "A skill cannot contain more than 100 contexts",
            409,
          );
        }
        await client.query(
          `INSERT INTO skill_contexts
               (id, workspace_id, skill_id, slug, name, context_type,
                external_reference, description, metadata)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            contextId,
            options.principal.workspaceId,
            options.skillId,
            slug,
            name,
            type,
            externalReference,
            description,
            metadata,
          ],
        );
        await client.query(
          `INSERT INTO context_knowledge_revisions
               (id, workspace_id, context_id, revision, base_revision_id,
                knowledge, body_digest, learning_metadata,
                created_by_actor_type, created_by_actor_id, created_for_user_id)
             VALUES ($1, $2, $3, 1, NULL, $4, $5, $6, $7, $8, $9)`,
          [
            revisionId,
            options.principal.workspaceId,
            contextId,
            knowledge,
            bodyDigest,
            learningMetadata,
            actor.actorType,
            actor.actorId,
            options.principal.kind === "user"
              ? options.principal.userId
              : (options.principal.delegatedUserId ?? null),
          ],
        );
        await client.query(
          `UPDATE skill_contexts
                SET current_knowledge_revision_id = $2, updated_at = now()
              WHERE id = $1`,
          [contextId, revisionId],
        );
        const contextResult = await client.query<ContextRow>(
          `${contextSelect} WHERE context.id = $1 AND context.workspace_id = $2`,
          [contextId, options.principal.workspaceId],
        );
        const knowledgeResult = await client.query<KnowledgeRow>(
          `SELECT * FROM context_knowledge_revisions
              WHERE id = $1 AND workspace_id = $2`,
          [revisionId, options.principal.workspaceId],
        );
        const contextRow = contextResult.rows[0];
        const knowledgeRow = knowledgeResult.rows[0];
        if (!contextRow || !knowledgeRow) {
          throw new DomainError(
            "CONTEXT_NOT_FOUND",
            "Created context could not be read",
            500,
          );
        }
        const response: ContextCreateResult = {
          context: toContextRecord(contextRow),
          knowledge: toContextKnowledgeRevisionRecord(knowledgeRow),
        };
        await this.idempotency.complete(client, claim.identity, 201, {
          context: response.context,
          knowledge: response.knowledge,
        });
        return response;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      if (isUniqueViolation(error, "skill_contexts_skill_slug_unique")) {
        throw new DomainError(
          "CONTEXT_SLUG_CONFLICT",
          "A context with this slug already exists under the skill",
          409,
          { slug },
        );
      }
      throw error;
    }
  }

  async update(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly patch: {
      readonly name?: string;
      readonly type?: ContextType;
      readonly externalReference?: string | null;
      readonly description?: string;
      readonly metadata?: Readonly<Record<string, unknown>>;
    };
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<ContextRecord> {
    authorize(options.principal, "contexts:write");
    if (Object.keys(options.patch).length === 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "At least one context field must be updated",
        400,
      );
    }
    const patch = {
      ...(options.patch.name !== undefined
        ? { name: normalizeContextName(options.patch.name) }
        : {}),
      ...(options.patch.type !== undefined
        ? { type: parseContextType(options.patch.type) }
        : {}),
      ...(options.patch.externalReference !== undefined
        ? {
            externalReference: normalizeExternalReference(
              options.patch.externalReference,
            ),
          }
        : {}),
      ...(options.patch.description !== undefined
        ? { description: normalizeDescription(options.patch.description) }
        : {}),
      ...(options.patch.metadata !== undefined
        ? { metadata: normalizeMetadata(options.patch.metadata) }
        : {}),
    };
    const requestHash = await hashIdempotentRequest({
      operation: "context.update",
      contextId: options.contextId,
      patch,
    });
    const claim = await this.idempotency.claim<{ context: ContextRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.update:${options.contextId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.context;
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const current = await client.query<ContextRow>(
          `${contextSelect}
             WHERE context.id = $1 AND context.workspace_id = $2
             FOR UPDATE OF context`,
          [options.contextId, options.principal.workspaceId],
        );
        const row = current.rows[0];
        if (!row) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
        }
        if (row.archived_at) {
          throw new DomainError(
            "CONTEXT_ARCHIVED",
            "Archived contexts cannot be changed",
            409,
          );
        }
        await client.query(
          `UPDATE skill_contexts
                SET name = $3, context_type = $4, external_reference = $5,
                    description = $6, metadata = $7, updated_at = now()
              WHERE id = $1 AND workspace_id = $2`,
          [
            options.contextId,
            options.principal.workspaceId,
            patch.name ?? row.name,
            patch.type ?? row.context_type,
            "externalReference" in patch
              ? patch.externalReference
              : row.external_reference,
            patch.description ?? row.description,
            patch.metadata ?? row.metadata,
          ],
        );
        const updated = await client.query<ContextRow>(
          `${contextSelect} WHERE context.id = $1 AND context.workspace_id = $2`,
          [options.contextId, options.principal.workspaceId],
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
        }
        const context = toContextRecord(updatedRow);
        await this.idempotency.complete(client, claim.identity, 200, { context });
        return context;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      throw error;
    }
  }

  async setArchived(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly archived: boolean;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<ContextRecord> {
    authorize(options.principal, "contexts:write");
    const requestHash = await hashIdempotentRequest({
      operation: "context.archive",
      contextId: options.contextId,
      archived: options.archived,
    });
    const claim = await this.idempotency.claim<{ context: ContextRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.archive:${options.contextId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.context;
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const updated = await client.query<ContextRow>(
          `UPDATE skill_contexts context
                SET archived_at = CASE WHEN $3 THEN COALESCE(archived_at, now())
                                       ELSE NULL END,
                    updated_at = now()
              WHERE context.id = $1 AND context.workspace_id = $2
              RETURNING context.id, context.workspace_id, context.skill_id,
                        context.slug, context.name, context.context_type,
                        context.external_reference, context.description,
                        context.metadata, context.current_knowledge_revision_id,
                        NULL::integer AS current_knowledge_revision,
                        context.archived_at, context.created_at, context.updated_at`,
          [options.contextId, options.principal.workspaceId, options.archived],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
        }
        const reread = await client.query<ContextRow>(
          `${contextSelect} WHERE context.id = $1 AND context.workspace_id = $2`,
          [options.contextId, options.principal.workspaceId],
        );
        const contextRow = reread.rows[0];
        if (!contextRow) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
        }
        const context = toContextRecord(contextRow);
        await this.idempotency.complete(client, claim.identity, 200, { context });
        return context;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      throw error;
    }
  }
}
