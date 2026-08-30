import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import {
  normalizeMetadata,
  normalizeRevisionBody,
  sha256TextDigest,
} from "./contexts.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import {
  insertMutationAudit,
  mutationAttribution,
  type MutationAuditContext,
} from "./mutation-audit.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { enqueueResourceRoutingProjection } from "./projection-events.js";
import { withDomainTransaction as withTransaction } from "./transactions.js";

export const NOTE_ARCHIVE_FILTERS = ["active", "archived", "all"] as const;
export type NoteArchiveFilter = (typeof NOTE_ARCHIVE_FILTERS)[number];

const MAX_ACTIVE_NOTES = 500;
const MAX_NOTE_BYTES = 256 * 1024;

export interface ContextNoteRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly contextId: string;
  readonly key: string;
  readonly title: string;
  readonly currentRevisionId: string;
  readonly currentRevision: number;
  readonly currentRevisionBaseId: string | null;
  readonly currentRevisionCreatedAt: string;
  readonly body: string;
  readonly bodyDigest: `sha256:${string}`;
  readonly learningMetadata: Readonly<Record<string, unknown>>;
  readonly archivedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ContextNoteRevisionRecord {
  readonly id: string;
  readonly workspaceId: string;
  readonly noteId: string;
  readonly revision: number;
  readonly baseRevisionId: string | null;
  readonly title: string;
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

interface NoteRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly context_id: string;
  readonly note_key: string;
  readonly title: string;
  readonly current_revision_id: string;
  readonly current_revision: number;
  readonly current_revision_base_id: string | null;
  readonly current_revision_created_at: Date;
  readonly body: string;
  readonly body_digest: `sha256:${string}`;
  readonly learning_metadata: Record<string, unknown>;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RevisionRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly note_id: string;
  readonly revision: number;
  readonly base_revision_id: string | null;
  readonly title: string;
  readonly body: string;
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

export function normalizeNoteTitle(value: unknown): string {
  const title = typeof value === "string" ? value.trim() : "";
  if (!title || title.length > 240) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Note title must be between 1 and 240 characters",
      400,
      { field: "title" },
    );
  }
  return title;
}

export function normalizeNoteBody(value: unknown): string {
  return normalizeRevisionBody(value, {
    field: "body",
    maxBytes: MAX_NOTE_BYTES,
  });
}

export function parseNoteArchiveFilter(value: unknown): NoteArchiveFilter {
  if (
    typeof value !== "string" ||
    !(NOTE_ARCHIVE_FILTERS as readonly string[]).includes(value)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Note state must be active, archived, or all",
      400,
      { field: "state" },
    );
  }
  return value as NoteArchiveFilter;
}

function validateExpectedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new DomainError(
      "NOTE_REVISION_CONFLICT",
      "A positive expectedRevision is required to update a note",
      409,
      { field: "expectedRevision" },
    );
  }
  return value;
}

function toNoteRecord(row: NoteRow): ContextNoteRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    contextId: row.context_id,
    key: row.note_key,
    title: row.title,
    currentRevisionId: row.current_revision_id,
    currentRevision: row.current_revision,
    currentRevisionBaseId: row.current_revision_base_id,
    currentRevisionCreatedAt: row.current_revision_created_at.toISOString(),
    body: row.body,
    bodyDigest: row.body_digest,
    learningMetadata: row.learning_metadata,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function toRevisionRecord(row: RevisionRow): ContextNoteRevisionRecord {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    noteId: row.note_id,
    revision: row.revision,
    baseRevisionId: row.base_revision_id,
    title: row.title,
    body: row.body,
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

const noteSelect = `
  SELECT note.id, note.workspace_id, note.context_id, note.note_key,
         note.title, note.current_revision_id,
         revision.revision AS current_revision, revision.body,
         revision.base_revision_id AS current_revision_base_id,
         revision.created_at AS current_revision_created_at,
         revision.body_digest, revision.learning_metadata,
         note.archived_at, note.created_at, note.updated_at
    FROM context_notes note
    JOIN context_note_revisions revision
      ON revision.id = note.current_revision_id
     AND revision.note_id = note.id`;

const revisionSelect = `
  SELECT revision.id, revision.workspace_id, revision.note_id,
         revision.revision, revision.base_revision_id, revision.title,
         revision.body, revision.body_digest, revision.learning_metadata,
         revision.created_by_actor_type, revision.created_by_actor_id,
         revision.created_by_agent, revision.created_by_model,
         revision.created_for_user_id, revision.created_at
    FROM context_note_revisions revision`;

export class ContextNoteService {
  constructor(
    readonly pool: Pool,
    readonly idempotency: IdempotencyStore,
  ) {}

  async list(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly archive?: NoteArchiveFilter;
    readonly allowArchivedContext?: boolean;
  }): Promise<readonly ContextNoteRecord[]> {
    authorize(options.principal, "contexts:read");
    const archive = parseNoteArchiveFilter(options.archive ?? "active");
    const result = await this.pool.query<NoteRow>(
      `${noteSelect}
        JOIN skill_contexts context
          ON context.id = note.context_id
         AND context.workspace_id = note.workspace_id
       WHERE note.context_id = $1
         AND note.workspace_id = $2
         AND ($3::boolean OR context.archived_at IS NULL)
         AND ($4 = 'all'
           OR ($4 = 'active' AND note.archived_at IS NULL)
           OR ($4 = 'archived' AND note.archived_at IS NOT NULL))
       ORDER BY note.updated_at DESC, note.id`,
      [
        options.contextId,
        options.principal.workspaceId,
        options.allowArchivedContext ?? false,
        archive,
      ],
    );
    if (result.rows.length === 0) {
      const context = await this.pool.query(
        `SELECT 1
           FROM skill_contexts
          WHERE id = $1 AND workspace_id = $2
            AND ($3::boolean OR archived_at IS NULL)`,
        [
          options.contextId,
          options.principal.workspaceId,
          options.allowArchivedContext ?? false,
        ],
      );
      if (context.rowCount !== 1) {
        throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
      }
    }
    return result.rows.map(toNoteRecord);
  }

  async get(options: {
    readonly noteId: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<ContextNoteRecord> {
    authorize(options.principal, "contexts:read");
    const result = await this.pool.query<NoteRow>(
      `${noteSelect}
       WHERE note.id = $1 AND note.workspace_id = $2
         AND ($3::boolean OR note.archived_at IS NULL)`,
      [options.noteId, options.principal.workspaceId, options.allowArchived ?? false],
    );
    const row = result.rows[0];
    if (!row)
      throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
    return toNoteRecord(row);
  }

  async history(options: {
    readonly noteId: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<readonly ContextNoteRevisionRecord[]> {
    authorize(options.principal, "contexts:read");
    const result = await this.pool.query<RevisionRow>(
      `${revisionSelect}
        JOIN context_notes note
          ON note.id = revision.note_id
         AND note.workspace_id = revision.workspace_id
       WHERE note.id = $1 AND note.workspace_id = $2
         AND ($3::boolean OR note.archived_at IS NULL)
       ORDER BY revision.revision DESC, revision.id`,
      [options.noteId, options.principal.workspaceId, options.allowArchived ?? false],
    );
    if (result.rows.length === 0) {
      throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
    }
    return result.rows.map(toRevisionRecord);
  }

  async create(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly title: string;
    readonly body: string;
    readonly learningMetadata?: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly fencingEpoch?: number;
    readonly auditContext?: MutationAuditContext;
  }): Promise<ContextNoteRecord> {
    authorize(options.principal, "contexts:write");
    const title = normalizeNoteTitle(options.title);
    const body = normalizeNoteBody(options.body);
    const learningMetadata = normalizeMetadata(
      options.learningMetadata,
      "learningMetadata",
    );
    const bodyDigest = await sha256TextDigest(body);
    const requestHash = await hashIdempotentRequest({
      operation: "context.note.create",
      contextId: options.contextId,
      title,
      bodyDigest,
      learningMetadata,
    });
    const claim = await this.idempotency.claim<{ note: ContextNoteRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.note.create:${options.contextId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.note;

    const noteId = id("context-note");
    const noteKey = `note-${crypto.randomUUID()}`;
    const revisionId = id("context-note-revision");
    const actor = principalAuditActor(options.principal);
    const attribution = mutationAttribution(options.auditContext);
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const context = await client.query<{
          archived_at: Date | null;
          skill_archived_at: Date | null;
        }>(
          `SELECT context.archived_at, skill.archived_at AS skill_archived_at
               FROM skill_contexts context
               JOIN skills skill
                 ON skill.id = context.skill_id
                AND skill.workspace_id = context.workspace_id
              WHERE context.id = $1 AND context.workspace_id = $2
              FOR SHARE OF context`,
          [options.contextId, options.principal.workspaceId],
        );
        const contextRow = context.rows[0];
        if (!contextRow) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
        }
        if (contextRow.archived_at || contextRow.skill_archived_at) {
          throw new DomainError(
            "CONTEXT_ARCHIVED",
            "Archived contexts cannot receive notes",
            409,
          );
        }
        const count = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count
               FROM context_notes
              WHERE context_id = $1 AND archived_at IS NULL`,
          [options.contextId],
        );
        if (Number(count.rows[0]?.count ?? 0) >= MAX_ACTIVE_NOTES) {
          throw new DomainError(
            "NOTE_LIMIT_REACHED",
            "A context cannot contain more than 500 active notes",
            409,
          );
        }
        await client.query(
          `INSERT INTO context_notes
               (id, workspace_id, context_id, note_key, title)
             VALUES ($1, $2, $3, $4, $5)`,
          [noteId, options.principal.workspaceId, options.contextId, noteKey, title],
        );
        await client.query(
          `INSERT INTO context_note_revisions
               (id, workspace_id, note_id, revision, base_revision_id,
                title, body, body_digest, learning_metadata,
                created_by_actor_type, created_by_actor_id, created_by_agent,
                created_by_model, created_for_user_id)
             VALUES ($1, $2, $3, 1, NULL, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            revisionId,
            options.principal.workspaceId,
            noteId,
            title,
            body,
            bodyDigest,
            learningMetadata,
            actor.actorType,
            actor.actorId,
            attribution.agent,
            attribution.model,
            options.principal.kind === "user"
              ? options.principal.userId
              : (options.principal.delegatedUserId ?? null),
          ],
        );
        await client.query(
          `UPDATE context_notes
                SET current_revision_id = $2, updated_at = now()
              WHERE id = $1`,
          [noteId, revisionId],
        );
        const inserted = await client.query<NoteRow>(
          `${noteSelect} WHERE note.id = $1 AND note.workspace_id = $2`,
          [noteId, options.principal.workspaceId],
        );
        const row = inserted.rows[0];
        if (!row) {
          throw new DomainError(
            "NOTE_NOT_FOUND",
            "Context note could not be created",
            500,
          );
        }
        const note = toNoteRecord(row);
        await insertMutationAudit(client, options.principal, options.auditContext, {
          eventType: "context.note.created",
          action: "contexts:write",
          requestId: options.requestId,
          resourceType: "context_note_revision",
          resourceId: note.currentRevisionId,
          contextId: options.contextId,
          metadata: {
            noteId: note.id,
            revision: note.currentRevision,
            baseRevisionId: note.currentRevisionBaseId,
            digest: note.bodyDigest,
          },
        });
        await enqueueResourceRoutingProjection(client, {
          workspaceId: options.principal.workspaceId,
          resources: [{ resourceType: "context_note", resourceId: note.id }],
          fencingEpoch: options.fencingEpoch,
        });
        await this.idempotency.complete(client, claim.identity, 201, { note });
        return note;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      throw error;
    }
  }

  async update(options: {
    readonly noteId: string;
    readonly principal: Principal;
    readonly expectedRevision: number;
    readonly title: string;
    readonly body: string;
    readonly learningMetadata?: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly auditContext?: MutationAuditContext;
  }): Promise<ContextNoteRecord> {
    authorize(options.principal, "contexts:write");
    const expectedRevision = validateExpectedRevision(options.expectedRevision);
    const title = normalizeNoteTitle(options.title);
    const body = normalizeNoteBody(options.body);
    const learningMetadata = normalizeMetadata(
      options.learningMetadata,
      "learningMetadata",
    );
    const bodyDigest = await sha256TextDigest(body);
    const requestHash = await hashIdempotentRequest({
      operation: "context.note.update",
      noteId: options.noteId,
      expectedRevision,
      title,
      bodyDigest,
      learningMetadata,
    });
    const claim = await this.idempotency.claim<{ note: ContextNoteRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.note.update:${options.noteId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.note;

    const revisionId = id("context-note-revision");
    const actor = principalAuditActor(options.principal);
    const attribution = mutationAttribution(options.auditContext);
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const current = await client.query<{
          context_id: string;
          current_revision_id: string;
          current_revision: number;
          note_archived_at: Date | null;
          context_archived_at: Date | null;
          skill_archived_at: Date | null;
        }>(
          `SELECT note.context_id, note.current_revision_id,
                    revision.revision AS current_revision,
                    note.archived_at AS note_archived_at,
                    context.archived_at AS context_archived_at,
                    skill.archived_at AS skill_archived_at
               FROM context_notes note
               JOIN context_note_revisions revision
                 ON revision.id = note.current_revision_id
                AND revision.note_id = note.id
               JOIN skill_contexts context
                 ON context.id = note.context_id
                AND context.workspace_id = note.workspace_id
               JOIN skills skill
                 ON skill.id = context.skill_id
                AND skill.workspace_id = context.workspace_id
              WHERE note.id = $1 AND note.workspace_id = $2
              FOR UPDATE OF note`,
          [options.noteId, options.principal.workspaceId],
        );
        const currentRow = current.rows[0];
        if (!currentRow) {
          throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
        }
        if (currentRow.note_archived_at) {
          throw new DomainError(
            "NOTE_ARCHIVED",
            "Archived notes cannot receive revisions",
            409,
          );
        }
        if (currentRow.context_archived_at || currentRow.skill_archived_at) {
          throw new DomainError(
            "CONTEXT_ARCHIVED",
            "Archived contexts cannot receive note revisions",
            409,
          );
        }
        if (currentRow.current_revision !== expectedRevision) {
          throw new DomainError(
            "NOTE_REVISION_CONFLICT",
            "The note changed after the editor was opened",
            409,
            {
              currentRevision: currentRow.current_revision,
              currentRevisionId: currentRow.current_revision_id,
            },
          );
        }
        await client.query(
          `INSERT INTO context_note_revisions
               (id, workspace_id, note_id, revision, base_revision_id,
                title, body, body_digest, learning_metadata,
                created_by_actor_type, created_by_actor_id, created_by_agent,
                created_by_model, created_for_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
          [
            revisionId,
            options.principal.workspaceId,
            options.noteId,
            currentRow.current_revision + 1,
            currentRow.current_revision_id,
            title,
            body,
            bodyDigest,
            learningMetadata,
            actor.actorType,
            actor.actorId,
            attribution.agent,
            attribution.model,
            options.principal.kind === "user"
              ? options.principal.userId
              : (options.principal.delegatedUserId ?? null),
          ],
        );
        await client.query(
          `UPDATE context_notes
                SET title = $3, current_revision_id = $4, updated_at = now()
              WHERE id = $1 AND workspace_id = $2`,
          [options.noteId, options.principal.workspaceId, title, revisionId],
        );
        const updated = await client.query<NoteRow>(
          `${noteSelect} WHERE note.id = $1 AND note.workspace_id = $2`,
          [options.noteId, options.principal.workspaceId],
        );
        const row = updated.rows[0];
        if (!row) {
          throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
        }
        const note = toNoteRecord(row);
        await insertMutationAudit(client, options.principal, options.auditContext, {
          eventType: "context.note.revised",
          action: "contexts:write",
          requestId: options.requestId,
          resourceType: "context_note_revision",
          resourceId: note.currentRevisionId,
          contextId: currentRow.context_id,
          metadata: {
            noteId: note.id,
            revision: note.currentRevision,
            baseRevisionId: note.currentRevisionBaseId,
            digest: note.bodyDigest,
          },
        });
        await this.idempotency.complete(client, claim.identity, 200, { note });
        return note;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      throw error;
    }
  }

  async archive(options: {
    readonly noteId: string;
    readonly principal: Principal;
    readonly idempotencyKey: string;
    readonly requestId: string;
  }): Promise<ContextNoteRecord> {
    authorize(options.principal, "contexts:write");
    const requestHash = await hashIdempotentRequest({
      operation: "context.note.archive",
      noteId: options.noteId,
    });
    const claim = await this.idempotency.claim<{ note: ContextNoteRecord }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.note.archive:${options.noteId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.note;
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const archived = await client.query(
          `UPDATE context_notes
                SET archived_at = COALESCE(archived_at, now()), updated_at = now()
              WHERE id = $1 AND workspace_id = $2
              RETURNING id`,
          [options.noteId, options.principal.workspaceId],
        );
        if (archived.rowCount !== 1) {
          throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
        }
        const result = await client.query<NoteRow>(
          `${noteSelect} WHERE note.id = $1 AND note.workspace_id = $2`,
          [options.noteId, options.principal.workspaceId],
        );
        const row = result.rows[0];
        if (!row) {
          throw new DomainError("NOTE_NOT_FOUND", "Context note was not found", 404);
        }
        const note = toNoteRecord(row);
        await this.idempotency.complete(client, claim.identity, 200, { note });
        return note;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      throw error;
    }
  }
}
