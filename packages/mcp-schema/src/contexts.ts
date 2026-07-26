import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  contextSelectorSchema,
  knowledgeSelectorSchema,
  limitSchema,
  noteStateSchema,
  nullableCursorSchema,
  skillSelectorSchema,
  stableIdSchema,
} from "./common.js";
import { contextNoteOutputSchema, retrievedContextSchema } from "./retrieve.js";

export const contextGetInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    knowledge: knowledgeSelectorSchema.default({ selector: "current" }),
    includeNotes: z.boolean().default(true),
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextGetOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    context: retrievedContextSchema,
  })
  .strict();

export const contextNotesListInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    state: noteStateSchema.default("active"),
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextNotesListOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    contextId: stableIdSchema,
    notes: z.array(contextNoteOutputSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export type ContextGetInput = z.infer<typeof contextGetInputSchema>;
export type ContextGetOutput = z.infer<typeof contextGetOutputSchema>;
export type ContextNotesListInput = z.infer<typeof contextNotesListInputSchema>;
export type ContextNotesListOutput = z.infer<typeof contextNotesListOutputSchema>;
