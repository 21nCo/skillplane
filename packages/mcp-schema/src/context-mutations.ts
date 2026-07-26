import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  contextSelectorSchema,
  digestSchema,
  skillSelectorSchema,
  slugSchema,
  stableIdSchema,
  timestampSchema,
} from "./common.js";

const idempotencyKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
const learningMetadataSchema = z.record(z.string(), z.unknown()).default({});

export const contextKnowledgeUpdateInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    expectedRevision: z.number().int().nonnegative(),
    markdown: z
      .string()
      .min(1)
      .max(512 * 1024),
    learningMetadata: learningMetadataSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextKnowledgeMutationOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    contextId: stableIdSchema,
    knowledge: z
      .object({
        id: stableIdSchema,
        revision: z.number().int().positive(),
        baseRevisionId: stableIdSchema.nullable(),
        digest: digestSchema,
        markdown: z.string(),
        learningMetadata: z.record(z.string(), z.unknown()),
        createdAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

export const contextNoteUpsertInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    noteId: stableIdSchema.nullable().default(null),
    expectedRevision: z.number().int().positive().nullable().default(null),
    title: z.string().trim().min(1).max(240),
    markdown: z
      .string()
      .min(1)
      .max(256 * 1024),
    learningMetadata: learningMetadataSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextNoteMutationOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    contextId: stableIdSchema,
    note: z
      .object({
        id: stableIdSchema,
        slug: slugSchema,
        title: z.string().min(1).max(240),
        archivedAt: timestampSchema.nullable(),
        currentRevision: z
          .object({
            id: stableIdSchema,
            revision: z.number().int().positive(),
            baseRevisionId: stableIdSchema.nullable(),
            digest: digestSchema,
            markdown: z.string(),
            learningMetadata: z.record(z.string(), z.unknown()),
            createdAt: timestampSchema,
          })
          .strict(),
        createdAt: timestampSchema,
        updatedAt: timestampSchema,
      })
      .strict(),
  })
  .strict();

export type ContextKnowledgeUpdateInput = z.infer<
  typeof contextKnowledgeUpdateInputSchema
>;
export type ContextKnowledgeMutationOutput = z.infer<
  typeof contextKnowledgeMutationOutputSchema
>;
export type ContextNoteUpsertInput = z.infer<typeof contextNoteUpsertInputSchema>;
export type ContextNoteMutationOutput = z.infer<typeof contextNoteMutationOutputSchema>;
