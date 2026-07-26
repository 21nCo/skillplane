import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  contextSelectorSchema,
  digestSchema,
  fileDescriptorSchema,
  knowledgeSelectorSchema,
  manifestSchema,
  skillSelectorSchema,
  skillVisibilitySchema,
  slugSchema,
  stableIdSchema,
  timestampSchema,
  versionSelectorSchema,
  versionStateSchema,
} from "./common.js";

export const skillRetrieveInputSchema = z
  .object({
    skill: skillSelectorSchema,
    version: versionSelectorSchema.default({ selector: "current" }),
    context: z
      .object({
        selector: contextSelectorSchema,
        knowledge: knowledgeSelectorSchema.default({ selector: "current" }),
        includeNotes: z.boolean().default(false),
      })
      .strict()
      .optional(),
    caller: callerDeclarationSchema,
  })
  .strict();

export const contextKnowledgeOutputSchema = z
  .object({
    id: stableIdSchema,
    revision: z.number().int().positive(),
    digest: digestSchema,
    markdown: z.string(),
    createdAt: timestampSchema,
  })
  .strict();

export const contextNoteOutputSchema = z
  .object({
    id: stableIdSchema,
    slug: slugSchema,
    title: z.string().min(1).max(240),
    archivedAt: timestampSchema.nullable(),
    currentRevision: z
      .object({
        id: stableIdSchema,
        revision: z.number().int().positive(),
        digest: digestSchema,
        markdown: z.string(),
        createdAt: timestampSchema,
      })
      .strict(),
    updatedAt: timestampSchema,
  })
  .strict();

export const retrievedContextSchema = z
  .object({
    id: stableIdSchema,
    slug: slugSchema,
    name: z.string().min(1).max(160),
    description: z.string().max(20_000),
    type: z.enum(["repository", "customer", "environment", "project", "custom"]),
    externalReference: z.string().max(2_048).nullable(),
    metadata: z.record(z.string(), z.unknown()),
    knowledge: contextKnowledgeOutputSchema.nullable(),
    notes: z.array(contextNoteOutputSchema).max(500),
  })
  .strict();

export const skillRetrieveOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skill: z
      .object({
        id: stableIdSchema,
        workspaceId: stableIdSchema,
        workspaceSlug: slugSchema,
        slug: slugSchema,
        name: z.string().min(1).max(160),
        description: z.string().max(20_000),
        tags: z.array(z.string().max(80)).max(30),
        visibility: skillVisibilitySchema,
      })
      .strict(),
    version: z
      .object({
        id: stableIdSchema,
        revision: z.number().int().positive(),
        semanticVersion: z.string().max(160).nullable(),
        state: versionStateSchema,
        digest: digestSchema,
        byteSize: z.number().int().nonnegative(),
        manifest: manifestSchema,
        createdAt: timestampSchema,
        publishedAt: timestampSchema.nullable(),
      })
      .strict(),
    instructions: z.string(),
    files: z.array(fileDescriptorSchema).max(1_000),
    context: retrievedContextSchema.nullable(),
  })
  .strict();

export type SkillRetrieveInput = z.infer<typeof skillRetrieveInputSchema>;
export type SkillRetrieveOutput = z.infer<typeof skillRetrieveOutputSchema>;
export type RetrievedContext = z.infer<typeof retrievedContextSchema>;
export type ContextNoteOutput = z.infer<typeof contextNoteOutputSchema>;
