import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  digestSchema,
  limitSchema,
  nullableCursorSchema,
  skillSelectorSchema,
  stableIdSchema,
  timestampSchema,
  versionStateSchema,
} from "./common.js";

export const skillVersionsListInputSchema = z
  .object({
    skill: skillSelectorSchema,
    states: z.array(versionStateSchema).min(1).max(4).default(["published"]),
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillVersionHistoryItemSchema = z
  .object({
    id: stableIdSchema,
    revision: z.number().int().positive(),
    semanticVersion: z.string().max(160).nullable(),
    state: versionStateSchema,
    source: z.enum(["human", "agent_amendment", "import"]),
    digest: digestSchema,
    baseVersionId: stableIdSchema.nullable(),
    proposedBump: z.enum(["patch", "minor", "major"]).nullable(),
    changeSummary: z.string().max(2_000),
    learningSummary: z.string().max(2_000).nullable(),
    authorType: z.enum(["user", "service_principal", "system"]),
    publishedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .strict();

export const skillVersionsListOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skillId: stableIdSchema,
    versions: z.array(skillVersionHistoryItemSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export type SkillVersionsListInput = z.infer<typeof skillVersionsListInputSchema>;
export type SkillVersionsListOutput = z.infer<typeof skillVersionsListOutputSchema>;
