import type {
  ContextKnowledgeMutationOutput,
  ContextKnowledgeUpdateInput,
  ContextNoteMutationOutput,
  ContextNoteUpsertInput,
} from "@skillplane/mcp-schema";
import { McpToolError } from "@skillplane/mcp-schema";
import { resolveContext, resolveSkill } from "./resolve.js";
import {
  executeMutationTool,
  mutationAuditContext,
  type McpToolRuntime,
} from "./shared.js";

export function contextKnowledgeUpdate(
  runtime: McpToolRuntime,
  input: ContextKnowledgeUpdateInput,
) {
  return executeMutationTool(
    runtime,
    "context_knowledge_update",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:write",
        allowPublic: false,
      });
      if (!skill.principal) throw new Error("WORKSPACE_FORBIDDEN");
      const context = await resolveContext(runtime, execution, skill, input.context);
      const knowledge = await runtime.services.contextKnowledgeService.update({
        contextId: context.id,
        principal: skill.principal,
        expectedRevision: input.expectedRevision,
        body: input.markdown,
        learningMetadata: input.learningMetadata,
        idempotencyKey: input.idempotencyKey,
        requestId: execution.requestId,
        auditContext: mutationAuditContext(runtime, input.caller),
      });
      execution.setScope({
        resourceType: "context",
        resourceId: context.id,
        contextId: context.id,
      });
      const output: ContextKnowledgeMutationOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        contextId: context.id,
        knowledge: {
          id: knowledge.id,
          revision: knowledge.revision,
          baseRevisionId: knowledge.baseRevisionId,
          digest: knowledge.bodyDigest,
          markdown: knowledge.body,
          learningMetadata: knowledge.learningMetadata,
          createdAt: knowledge.createdAt,
        },
      };
      return { output };
    },
  );
}

export function contextNoteUpsert(
  runtime: McpToolRuntime,
  input: ContextNoteUpsertInput,
) {
  return executeMutationTool(
    runtime,
    "context_note_upsert",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:write",
        allowPublic: false,
      });
      if (!skill.principal) throw new Error("WORKSPACE_FORBIDDEN");
      const context = await resolveContext(runtime, execution, skill, input.context);
      if (
        (input.noteId === null && input.expectedRevision !== null) ||
        (input.noteId !== null && input.expectedRevision === null)
      ) {
        throw new McpToolError(
          input.noteId === null ? "VALIDATION_FAILED" : "NOTE_REVISION_CONFLICT",
          input.noteId === null
            ? "expectedRevision is only valid when updating a note"
            : "expectedRevision is required when updating a note",
          {
            status: input.noteId === null ? 400 : 409,
          },
        );
      }
      if (input.noteId !== null) {
        const ownership = await runtime.services.database.pool.query(
          `SELECT 1
             FROM context_notes
            WHERE id = $1 AND context_id = $2 AND workspace_id = $3
            LIMIT 1`,
          [input.noteId, context.id, skill.workspaceId],
        );
        if (ownership.rowCount !== 1) {
          throw new McpToolError("NOTE_NOT_FOUND", "The context note was not found", {
            status: 404,
          });
        }
      }
      const auditContext = mutationAuditContext(runtime, input.caller);
      let note;
      if (input.noteId === null) {
        note = await runtime.services.contextNoteService.create({
          contextId: context.id,
          principal: skill.principal,
          title: input.title,
          body: input.markdown,
          learningMetadata: input.learningMetadata,
          idempotencyKey: input.idempotencyKey,
          requestId: execution.requestId,
          auditContext,
        });
      } else {
        const expectedRevision = input.expectedRevision;
        if (expectedRevision === null) {
          throw new McpToolError(
            "NOTE_REVISION_CONFLICT",
            "expectedRevision is required when updating a note",
            { status: 409 },
          );
        }
        note = await runtime.services.contextNoteService.update({
          noteId: input.noteId,
          principal: skill.principal,
          expectedRevision,
          title: input.title,
          body: input.markdown,
          learningMetadata: input.learningMetadata,
          idempotencyKey: input.idempotencyKey,
          requestId: execution.requestId,
          auditContext,
        });
      }
      const output: ContextNoteMutationOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        contextId: context.id,
        note: {
          id: note.id,
          slug: note.key,
          title: note.title,
          archivedAt: note.archivedAt,
          currentRevision: {
            id: note.currentRevisionId,
            revision: note.currentRevision,
            baseRevisionId: note.currentRevisionBaseId,
            digest: note.bodyDigest,
            markdown: note.body,
            learningMetadata: note.learningMetadata,
            createdAt: note.currentRevisionCreatedAt,
          },
          createdAt: note.createdAt,
          updatedAt: note.updatedAt,
        },
      };
      return { output };
    },
  );
}
