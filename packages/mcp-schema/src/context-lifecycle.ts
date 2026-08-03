import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  contextSelectorSchema,
  digestSchema,
  limitSchema,
  noteStateSchema,
  nullableCursorSchema,
  skillSelectorSchema,
  slugSchema,
  stableIdSchema,
  timestampSchema,
} from "./common.js";
import { idempotencyKeySchema, learningMetadataSchema } from "./context-mutations.js";

export const contextTypeSchema = z.enum([
  "repository",
  "project",
  "customer",
  "environment",
  "custom",
]);

const metadataSchema = z.record(z.string(), z.unknown());

export const contextLifecycleRecordSchema = z
  .object({
    id: stableIdSchema,
    skillId: stableIdSchema,
    slug: slugSchema,
    name: z.string().min(1).max(160),
    type: contextTypeSchema,
    externalReference: z.string().max(2_000).nullable(),
    description: z.string().max(2_000),
    metadata: metadataSchema,
    currentKnowledge: z
      .object({
        id: stableIdSchema,
        revision: z.number().int().positive(),
      })
      .strict()
      .nullable(),
    archivedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const contextKnowledgeHistoryItemSchema = z
  .object({
    id: stableIdSchema,
    revision: z.number().int().positive(),
    baseRevisionId: stableIdSchema.nullable(),
    digest: digestSchema,
    markdown: z.string(),
    learningMetadata: metadataSchema,
    createdBy: z
      .object({
        actorType: z.enum(["user", "service_principal"]),
        agent: z.string().max(240).nullable(),
        model: z.string().max(240).nullable(),
      })
      .strict(),
    createdAt: timestampSchema,
  })
  .strict();

export const contextsListInputSchema = z
  .object({
    skill: skillSelectorSchema,
    state: noteStateSchema.default("active"),
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextsListOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    contexts: z.array(contextLifecycleRecordSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export const contextCreateInputSchema = z
  .object({
    skill: skillSelectorSchema,
    slug: slugSchema,
    name: z.string().trim().min(1).max(160),
    type: contextTypeSchema,
    externalReference: z.string().trim().min(1).max(2_000).nullable().default(null),
    description: z.string().trim().max(2_000).default(""),
    metadata: metadataSchema.default({}),
    initialKnowledge: z
      .string()
      .min(1)
      .max(512 * 1024),
    learningMetadata: learningMetadataSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextCreateOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    context: contextLifecycleRecordSchema,
    knowledge: contextKnowledgeHistoryItemSchema,
  })
  .strict();

const contextMetadataPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(160).optional(),
    type: contextTypeSchema.optional(),
    externalReference: z.string().trim().min(1).max(2_000).nullable().optional(),
    description: z.string().trim().max(2_000).optional(),
    metadata: metadataSchema.optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0, {
    message: "At least one context metadata field is required",
  });

export const contextUpdateInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    expectedUpdatedAt: timestampSchema,
    patch: contextMetadataPatchSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextLifecycleMutationOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    context: contextLifecycleRecordSchema,
  })
  .strict();

export const contextStateMutationInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    expectedUpdatedAt: timestampSchema,
    idempotencyKey: idempotencyKeySchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextKnowledgeHistoryInputSchema = z
  .object({
    skill: skillSelectorSchema,
    context: contextSelectorSchema,
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextKnowledgeHistoryOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    contextId: stableIdSchema,
    revisions: z.array(contextKnowledgeHistoryItemSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export type ContextLifecycleRecord = z.infer<typeof contextLifecycleRecordSchema>;
export type ContextKnowledgeHistoryItem = z.infer<
  typeof contextKnowledgeHistoryItemSchema
>;
export type ContextsListInput = z.infer<typeof contextsListInputSchema>;
export type ContextsListOutput = z.infer<typeof contextsListOutputSchema>;
export type ContextCreateInput = z.infer<typeof contextCreateInputSchema>;
export type ContextCreateOutput = z.infer<typeof contextCreateOutputSchema>;
export type ContextUpdateInput = z.infer<typeof contextUpdateInputSchema>;
export type ContextLifecycleMutationOutput = z.infer<
  typeof contextLifecycleMutationOutputSchema
>;
export type ContextStateMutationInput = z.infer<typeof contextStateMutationInputSchema>;
export type ContextKnowledgeHistoryInput = z.infer<
  typeof contextKnowledgeHistoryInputSchema
>;
export type ContextKnowledgeHistoryOutput = z.infer<
  typeof contextKnowledgeHistoryOutputSchema
>;
