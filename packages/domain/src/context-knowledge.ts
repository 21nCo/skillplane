import type { Pool } from "pg";
import { authorize } from "./authorization.js";
import {
  normalizeKnowledge,
  normalizeMetadata,
  sha256TextDigest,
  toContextKnowledgeRevisionRecord,
  type ContextKnowledgeRevisionRecord,
} from "./contexts.js";
import { DomainError } from "./errors.js";
import { hashIdempotentRequest, type IdempotencyStore } from "./idempotency.js";
import {
  insertMutationAudit,
  mutationAttribution,
  type MutationAuditContext,
} from "./mutation-audit.js";
import { principalAuditActor, type Principal } from "./principal.js";
import { withDomainTransaction as withTransaction } from "./transactions.js";

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

function id(): string {
  return `context-knowledge:${crypto.randomUUID()}`;
}

function validateExpectedRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "expectedRevision must be a non-negative integer",
      400,
      { field: "expectedRevision" },
    );
  }
  return value;
}

const revisionSelect = `
  SELECT revision.id, revision.workspace_id, revision.context_id,
         revision.revision, revision.base_revision_id,
         revision.knowledge, revision.body_digest, revision.learning_metadata,
         revision.created_by_actor_type, revision.created_by_actor_id,
         revision.created_by_agent, revision.created_by_model,
         revision.created_for_user_id, revision.created_at
    FROM context_knowledge_revisions revision`;

export class ContextKnowledgeService {
  constructor(
    readonly pool: Pool,
    readonly idempotency: IdempotencyStore,
  ) {}

  async getCurrent(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<ContextKnowledgeRevisionRecord> {
    authorize(options.principal, "contexts:read");
    const result = await this.pool.query<KnowledgeRow>(
      `${revisionSelect}
        JOIN skill_contexts context
          ON context.id = revision.context_id
         AND context.workspace_id = revision.workspace_id
         AND context.current_knowledge_revision_id = revision.id
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
      throw new DomainError(
        "CONTEXT_NOT_FOUND",
        "Context knowledge was not found",
        404,
      );
    }
    return toContextKnowledgeRevisionRecord(row);
  }

  async history(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly allowArchived?: boolean;
  }): Promise<readonly ContextKnowledgeRevisionRecord[]> {
    authorize(options.principal, "contexts:read");
    const result = await this.pool.query<KnowledgeRow>(
      `${revisionSelect}
        JOIN skill_contexts context
          ON context.id = revision.context_id
         AND context.workspace_id = revision.workspace_id
       WHERE context.id = $1
         AND context.workspace_id = $2
         AND ($3::boolean OR context.archived_at IS NULL)
       ORDER BY revision.revision DESC, revision.id`,
      [
        options.contextId,
        options.principal.workspaceId,
        options.allowArchived ?? false,
      ],
    );
    if (result.rows.length === 0) {
      throw new DomainError(
        "CONTEXT_NOT_FOUND",
        "Context knowledge was not found",
        404,
      );
    }
    return result.rows.map(toContextKnowledgeRevisionRecord);
  }

  async update(options: {
    readonly contextId: string;
    readonly principal: Principal;
    readonly expectedRevision: number;
    readonly body: string;
    readonly learningMetadata?: Readonly<Record<string, unknown>>;
    readonly idempotencyKey: string;
    readonly requestId: string;
    readonly auditContext?: MutationAuditContext;
  }): Promise<ContextKnowledgeRevisionRecord> {
    authorize(options.principal, "contexts:write");
    const expectedRevision = validateExpectedRevision(options.expectedRevision);
    const body = normalizeKnowledge(options.body);
    const learningMetadata = normalizeMetadata(
      options.learningMetadata,
      "learningMetadata",
    );
    const bodyDigest = await sha256TextDigest(body);
    const requestHash = await hashIdempotentRequest({
      operation: "context.knowledge.update",
      contextId: options.contextId,
      expectedRevision,
      bodyDigest,
      learningMetadata,
    });
    const claim = await this.idempotency.claim<{
      knowledge: ContextKnowledgeRevisionRecord;
    }>({
      workspaceId: options.principal.workspaceId,
      principal: options.principal,
      operation: `context.knowledge.update:${options.contextId}`,
      key: options.idempotencyKey,
      requestHash,
    });
    if (claim.state === "replay") return claim.responseBody.knowledge;

    const revisionId = id();
    const actor = principalAuditActor(options.principal);
    const attribution = mutationAttribution(options.auditContext);
    try {
      return await withTransaction(this.pool, options.requestId, async ({ client }) => {
        const context = await client.query<{
          current_knowledge_revision_id: string | null;
          current_revision: number | null;
          archived_at: Date | null;
          skill_archived_at: Date | null;
        }>(
          `SELECT context.current_knowledge_revision_id,
                    current.revision AS current_revision,
                    context.archived_at,
                    skill.archived_at AS skill_archived_at
               FROM skill_contexts context
               JOIN skills skill
                 ON skill.id = context.skill_id
                AND skill.workspace_id = context.workspace_id
               LEFT JOIN context_knowledge_revisions current
                 ON current.id = context.current_knowledge_revision_id
                AND current.context_id = context.id
              WHERE context.id = $1 AND context.workspace_id = $2
              FOR UPDATE OF context`,
          [options.contextId, options.principal.workspaceId],
        );
        const contextRow = context.rows[0];
        if (!contextRow) {
          throw new DomainError("CONTEXT_NOT_FOUND", "Context was not found", 404);
        }
        if (contextRow.archived_at || contextRow.skill_archived_at) {
          throw new DomainError(
            "CONTEXT_ARCHIVED",
            "Archived contexts cannot receive knowledge revisions",
            409,
          );
        }
        const currentRevision = contextRow.current_revision ?? 0;
        if (currentRevision !== expectedRevision) {
          throw new DomainError(
            "CONTEXT_REVISION_CONFLICT",
            "Context knowledge changed after the editor was opened",
            409,
            {
              currentRevision,
              currentRevisionId: contextRow.current_knowledge_revision_id,
            },
          );
        }
        const revision = currentRevision + 1;
        const inserted = await client.query<KnowledgeRow>(
          `INSERT INTO context_knowledge_revisions
               (id, workspace_id, context_id, revision, base_revision_id,
                knowledge, body_digest, learning_metadata,
                created_by_actor_type, created_by_actor_id, created_by_agent,
                created_by_model, created_for_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
             RETURNING *`,
          [
            revisionId,
            options.principal.workspaceId,
            options.contextId,
            revision,
            contextRow.current_knowledge_revision_id,
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
          `UPDATE skill_contexts
                SET current_knowledge_revision_id = $2,
                    updated_at = GREATEST(
                      clock_timestamp(),
                      updated_at + interval '1 millisecond'
                    )
              WHERE id = $1 AND workspace_id = $3`,
          [options.contextId, revisionId, options.principal.workspaceId],
        );
        const insertedRow = inserted.rows[0];
        if (!insertedRow) {
          throw new DomainError(
            "CONTEXT_NOT_FOUND",
            "Context knowledge could not be created",
            500,
          );
        }
        const knowledge = toContextKnowledgeRevisionRecord(insertedRow);
        await insertMutationAudit(client, options.principal, options.auditContext, {
          eventType: "context.knowledge.revised",
          action: "contexts:write",
          requestId: options.requestId,
          resourceType: "context_knowledge_revision",
          resourceId: knowledge.id,
          contextId: options.contextId,
          metadata: {
            revision: knowledge.revision,
            baseRevisionId: knowledge.baseRevisionId,
            digest: knowledge.bodyDigest,
          },
        });
        await this.idempotency.complete(client, claim.identity, 200, {
          knowledge,
        });
        return knowledge;
      });
    } catch (error) {
      await this.idempotency.release(claim.identity);
      throw error;
    }
  }
}
