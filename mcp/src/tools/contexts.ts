import type {
  ContextGetInput,
  ContextGetOutput,
  ContextNotesListInput,
  ContextNotesListOutput,
} from "@skillplane/mcp-schema";
import { McpToolError } from "@skillplane/mcp-schema";
import {
  contextOutput,
  listContextNotes,
  resolveContext,
  resolveSkill,
  serializeNote,
} from "./resolve.js";
import { executeReadTool, type McpToolRuntime } from "./shared.js";

function parseNoteBoundary(value: Readonly<Record<string, unknown>>): {
  readonly updatedAt: string;
  readonly id: string;
} {
  if (
    typeof value.updatedAt !== "string" ||
    !Number.isFinite(Date.parse(value.updatedAt)) ||
    typeof value.id !== "string"
  ) {
    throw new McpToolError("CURSOR_INVALID", "The cursor is invalid");
  }
  return { updatedAt: value.updatedAt, id: value.id };
}

export function contextGet(runtime: McpToolRuntime, input: ContextGetInput) {
  return executeReadTool(runtime, "context_get", input.caller, async (execution) => {
    const skill = await resolveSkill(runtime, execution, input.skill, {
      action: "contexts:read",
      allowPublic: false,
    });
    const context = await resolveContext(runtime, execution, skill, input.context);
    const output: ContextGetOutput = {
      requestId: execution.requestId,
      skillId: skill.id,
      context: await contextOutput(runtime, context, {
        knowledge: input.knowledge,
        includeNotes: input.includeNotes,
      }),
    };
    return { output };
  });
}

export function contextNotesList(
  runtime: McpToolRuntime,
  input: ContextNotesListInput,
) {
  return executeReadTool(
    runtime,
    "context_notes_list",
    input.caller,
    async (execution) => {
      const skill = await resolveSkill(runtime, execution, input.skill, {
        action: "contexts:read",
        allowPublic: false,
      });
      const context = await resolveContext(runtime, execution, skill, input.context);
      const filters = {
        skillId: skill.id,
        contextId: context.id,
        state: input.state,
      };
      const boundary = input.cursor
        ? parseNoteBoundary(
            await runtime.cursors.decode(input.cursor, "context_notes_list", filters),
          )
        : undefined;
      const page = await listContextNotes(runtime, context, {
        state: input.state,
        limit: input.limit,
        ...(boundary ? { boundary } : {}),
      });
      const last = page.hasNext ? page.rows.at(-1) : undefined;
      const output: ContextNotesListOutput = {
        requestId: execution.requestId,
        skillId: skill.id,
        contextId: context.id,
        notes: page.rows.map(serializeNote),
        nextCursor: last
          ? await runtime.cursors.encode("context_notes_list", filters, {
              updatedAt: last.updated_at.toISOString(),
              id: last.id,
            })
          : null,
      };
      return { output };
    },
  );
}
