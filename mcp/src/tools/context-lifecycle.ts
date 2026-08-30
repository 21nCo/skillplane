import {
  McpToolError,
  type ContextCreateInput,
  type ContextCreateOutput,
  type ContextKnowledgeHistoryInput,
  type ContextKnowledgeHistoryItem,
  type ContextKnowledgeHistoryOutput,
  type ContextLifecycleMutationOutput,
  type ContextLifecycleRecord,
  type ContextsListInput,
  type ContextsListOutput,
  type ContextStateMutationInput,
  type ContextUpdateInput,
} from "@skillplane/mcp-schema";
import type { ContextKnowledgeRevisionRecord, ContextRecord } from "@skillplane/domain";
import { registerResourceRoutes } from "@skillplane/api";
import { resolveContext, resolveSkill } from "./resolve.js";
import {
  executeMutationTool,
  executeReadTool,
  mutationAuditContext,
  type McpToolRuntime,
} from "./shared.js";

interface ContextListRow {
  readonly id: string;
  readonly skill_id: string;
  readonly slug: string;
  readonly name: string;
  readonly context_type: ContextLifecycleRecord["type"];
  readonly external_reference: string | null;
  readonly description: string;
  readonly metadata: Record<string, unknown>;
  readonly current_knowledge_revision_id: string | null;
  readonly current_knowledge_revision: number | null;
  readonly archived_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface KnowledgeHistoryRow {
  readonly id: string;
  readonly revision: number;
  readonly base_revision_id: string | null;
  readonly knowledge: string;
  readonly body_digest: `sha256:${string}`;
  readonly learning_metadata: Record<string, unknown>;
  readonly created_by_actor_type: "user" | "service_principal";
  readonly created_by_agent: string | null;
  readonly created_by_model: string | null;
  readonly created_at: Date;
}

function listedContext(row: ContextListRow): ContextLifecycleRecord {
  return {
    id: row.id,
    skillId: row.skill_id,
    slug: row.slug,
    name: row.name,
    type: row.context_type,
    externalReference: row.external_reference,
    description: row.description,
    metadata: row.metadata,
    currentKnowledge:
      row.current_knowledge_revision_id && row.current_knowledge_revision
        ? {
            id: row.current_knowledge_revision_id,
            revision: row.current_knowledge_revision,
          }
        : null,
    archivedAt: row.archived_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function lifecycleContext(context: ContextRecord): ContextLifecycleRecord {
  if (
    (context.currentKnowledgeRevisionId === null) !==
    (context.currentKnowledgeRevision === null)
  ) {
    throw new Error("CONTEXT_KNOWLEDGE_INCONSISTENT");
  }
  return {
    id: context.id,
    skillId: context.skillId,
    slug: context.slug,
    name: context.name,
    type: context.type,
    externalReference: context.externalReference,
    description: context.description,
    metadata: context.metadata,
    currentKnowledge:
      context.currentKnowledgeRevisionId && context.currentKnowledgeRevision
        ? {
            id: context.currentKnowledgeRevisionId,
            revision: context.currentKnowledgeRevision,
          }
        : null,
    archivedAt: context.archivedAt,
    createdAt: context.createdAt,
    updatedAt: context.updatedAt,
  };
}

function knowledgeHistoryItem(
  knowledge: ContextKnowledgeRevisionRecord,
): ContextKnowledgeHistoryItem {
  return {
    id: knowledge.id,
    revision: knowledge.revision,
    baseRevisionId: knowledge.baseRevisionId,
    digest: knowledge.bodyDigest,
    markdown: knowledge.body,
    learningMetadata: knowledge.learningMetadata,
    createdBy: {
      actorType: knowledge.createdByActorType,
      agent: knowledge.createdByAgent,
      model: knowledge.createdByModel,
    },
    createdAt: knowledge.createdAt,
  };
}

function listedKnowledge(row: KnowledgeHistoryRow): ContextKnowledgeHistoryItem {
  return {
    id: row.id,
    revision: row.revision,
    baseRevisionId: row.base_revision_id,
    digest: row.body_digest,
    markdown: row.knowledge,
    learningMetadata: row.learning_metadata,
    createdBy: {
      actorType: row.created_by_actor_type,
      agent: row.created_by_agent,
      model: row.created_by_model,
    },
    createdAt: row.created_at.toISOString(),
  };
}

function contextBoundary(value: Readonly<Record<string, unknown>>): {
  readonly updatedAt: string;
  readonly id: string;
} {
  if (
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.id !== "string" ||
    !value.id
  ) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return { updatedAt: value.updatedAt, id: value.id };
}

function knowledgeBoundary(value: Readonly<Record<string, unknown>>): {
  readonly revision: number;
  readonly id: string;
} {
  if (
    !Number.isSafeInteger(value.revision) ||
    Number(value.revision) < 1 ||
    typeof value.id !== "string" ||
    !value.id
  ) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return { revision: Number(value.revision), id: value.id };
}

export function contextsList(runtime: McpToolRuntime, input: ContextsListInput) {
  return executeReadTool(runtime, "contexts_list", input.caller, async (execution) => {
    const skill = await resolveSkill(runtime, execution, input.skill, {
      action: "contexts:read",
      allowPublic: false,
      includeArchived: input.state !== "active",
    });
    const filters = {
      skillId: skill.id,
      state: input.state,
      actorId: runtime.identity.actorId,
      credentialId: runtime.identity.credentialId,
    };
    const boundary = input.cursor
      ? contextBoundary(
          await runtime.cursors.decode(input.cursor, "contexts_list", filters),
        )
      : null;
    const result = await runtime.services.database.pool.query<ContextListRow>(
      `SELECT context.id, context.skill_id, context.slug, context.name,
              context.context_type, context.external_reference,
              context.description, context.metadata,
              context.current_knowledge_revision_id,
              knowledge.revision AS current_knowledge_revision,
              context.archived_at, context.created_at, context.updated_at
         FROM skill_contexts context
         LEFT JOIN context_knowledge_revisions knowledge
           ON knowledge.id = context.current_knowledge_revision_id
          AND knowledge.context_id = context.id
        WHERE context.workspace_id = $1 AND context.skill_id = $2
          AND (
            ($3::text = 'active' AND context.archived_at IS NULL)
            OR ($3::text = 'archived' AND context.archived_at IS NOT NULL)
            OR $3::text = 'all'
          )
          AND (
            $4::timestamptz IS NULL
            OR context.updated_at < $4::timestamptz
            OR (context.updated_at = $4::timestamptz AND context.id > $5::text)
          )
        ORDER BY context.updated_at DESC, context.id ASC
        LIMIT $6`,
      [
        skill.workspaceId,
        skill.id,
        input.state,
        boundary?.updatedAt ?? null,
        boundary?.id ?? null,
        input.limit + 1,
      ],
    );
    const hasNext = result.rows.length > input.limit;
    const contexts = result.rows.slice(0, input.limit).map(listedContext);
    const last = hasNext ? contexts.at(-1) : undefined;
    const output: ContextsListOutput = {
      requestId: execution.requestId,
      skillId: skill.id,
      contexts,
      nextCursor: last
        ? await runtime.cursors.encode("contexts_list", filters, {
            updatedAt: last.updatedAt,
            id: last.id,
          })
        : null,
    };
    return { output };
  });
}

export function contextCreate(runtime: McpToolRuntime, input: ContextCreateInput) {
  return executeMutationTool(
    runtime,
    "context_create",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:write",
        allowPublic: false,
      });
      if (!skill.principal) throw new Error("WORKSPACE_FORBIDDEN");
      const created = await runtime.services.contextService.create({
        skillId: skill.id,
        principal: skill.principal,
        slug: input.slug,
        name: input.name,
        type: input.type,
        externalReference: input.externalReference,
        description: input.description,
        metadata: input.metadata,
        initialKnowledge: input.initialKnowledge,
        learningMetadata: input.learningMetadata,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        fencingEpoch: runtime.fencingEpoch,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      await registerResourceRoutes(runtime.services, skill.workspaceId, [
        { resourceType: "context", resourceId: created.context.id },
      ]);
      execution.setScope({
        resourceType: "context",
        resourceId: created.context.id,
        contextId: created.context.id,
      });
      const output: ContextCreateOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        context: lifecycleContext(created.context),
        knowledge: knowledgeHistoryItem(created.knowledge),
      };
      return { output };
    },
  );
}

export function contextUpdate(runtime: McpToolRuntime, input: ContextUpdateInput) {
  return executeMutationTool(
    runtime,
    "context_update",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:write",
        allowPublic: false,
      });
      if (!skill.principal) throw new Error("WORKSPACE_FORBIDDEN");
      const selected = await resolveContext(runtime, execution, skill, input.context);
      const context = await runtime.services.contextService.update({
        contextId: selected.id,
        principal: skill.principal,
        patch: {
          ...(input.patch.name !== undefined ? { name: input.patch.name } : {}),
          ...(input.patch.type !== undefined ? { type: input.patch.type } : {}),
          ...(input.patch.externalReference !== undefined
            ? { externalReference: input.patch.externalReference }
            : {}),
          ...(input.patch.description !== undefined
            ? { description: input.patch.description }
            : {}),
          ...(input.patch.metadata !== undefined
            ? { metadata: input.patch.metadata }
            : {}),
        },
        expectedUpdatedAt: input.expectedUpdatedAt,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      const output: ContextLifecycleMutationOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        context: lifecycleContext(context),
      };
      return { output };
    },
  );
}

function contextStateMutation(
  runtime: McpToolRuntime,
  input: ContextStateMutationInput,
  archived: boolean,
) {
  const tool = archived ? "context_archive" : "context_restore";
  return executeMutationTool(runtime, tool, input.caller, async (execution) => {
    const skill = await resolveSkill(runtime, execution, input.skill, {
      action: "contexts:write",
      allowPublic: false,
      includeArchived: true,
    });
    if (!skill.principal) throw new Error("WORKSPACE_FORBIDDEN");
    const selected = await resolveContext(runtime, execution, skill, input.context, {
      allowArchived: true,
    });
    const context = await runtime.services.contextService.setArchived({
      contextId: selected.id,
      principal: skill.principal,
      archived,
      expectedUpdatedAt: input.expectedUpdatedAt,
      idempotencyKey: input.idempotencyKey,
      requestId: execution.requestId,
      auditContext: mutationAuditContext(runtime, input.caller),
    });
    const output: ContextLifecycleMutationOutput = {
      requestId: execution.requestId,
      skillId: skill.id,
      context: lifecycleContext(context),
    };
    return { output };
  });
}

export function contextArchive(
  runtime: McpToolRuntime,
  input: ContextStateMutationInput,
) {
  return contextStateMutation(runtime, input, true);
}

export function contextRestore(
  runtime: McpToolRuntime,
  input: ContextStateMutationInput,
) {
  return contextStateMutation(runtime, input, false);
}

export function contextKnowledgeHistory(
  runtime: McpToolRuntime,
  input: ContextKnowledgeHistoryInput,
) {
  return executeReadTool(
    runtime,
    "context_knowledge_history",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:read",
        allowPublic: false,
        includeArchived: true,
      });
      const context = await resolveContext(runtime, execution, skill, input.context, {
        allowArchived: true,
      });
      const filters = {
        skillId: skill.id,
        contextId: context.id,
        actorId: runtime.identity.actorId,
        credentialId: runtime.identity.credentialId,
      };
      const boundary = input.cursor
        ? knowledgeBoundary(
            await runtime.cursors.decode(
              input.cursor,
              "context_knowledge_history",
              filters,
            ),
          )
        : null;
      const result = await runtime.services.database.pool.query<KnowledgeHistoryRow>(
        `SELECT revision.id, revision.revision, revision.base_revision_id,
                  revision.knowledge, revision.body_digest,
                  revision.learning_metadata, revision.created_by_actor_type,
                  revision.created_by_agent, revision.created_by_model,
                  revision.created_at
             FROM context_knowledge_revisions revision
            WHERE revision.workspace_id = $1 AND revision.context_id = $2
              AND (
                $3::integer IS NULL
                OR revision.revision < $3::integer
                OR (revision.revision = $3::integer AND revision.id > $4::text)
              )
            ORDER BY revision.revision DESC, revision.id ASC
            LIMIT $5`,
        [
          skill.workspaceId,
          context.id,
          boundary?.revision ?? null,
          boundary?.id ?? null,
          input.limit + 1,
        ],
      );
      const hasNext = result.rows.length > input.limit;
      const revisions = result.rows.slice(0, input.limit).map(listedKnowledge);
      const last = hasNext ? revisions.at(-1) : undefined;
      const output: ContextKnowledgeHistoryOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        contextId: context.id,
        revisions,
        nextCursor: last
          ? await runtime.cursors.encode("context_knowledge_history", filters, {
              revision: last.revision,
              id: last.id,
            })
          : null,
      };
      return { output };
    },
  );
}
