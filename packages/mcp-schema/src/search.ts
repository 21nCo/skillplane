import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  digestSchema,
  limitSchema,
  nullableCursorSchema,
  skillVisibilitySchema,
  slugSchema,
  stableIdSchema,
} from "./common.js";

export const skillsSearchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(500),
    workspaceId: stableIdSchema,
    visibility: z
      .array(skillVisibilitySchema)
      .min(1)
      .max(3)
      .default(["private", "workspace", "public"]),
    tags: z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(80)
          .regex(/^[\p{L}\p{N}._:-]+$/u),
      )
      .max(30)
      .default([]),
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillSearchItemSchema = z
  .object({
    id: stableIdSchema,
    workspaceId: stableIdSchema,
    workspaceSlug: slugSchema,
    slug: slugSchema,
    name: z.string().min(1).max(160),
    summary: z.string().max(20_000),
    tags: z.array(z.string().max(80)).max(30),
    visibility: skillVisibilitySchema,
    currentVersion: z
      .object({
        id: stableIdSchema,
        semanticVersion: z.string().min(1).max(160),
        digest: digestSchema,
      })
      .strict(),
  })
  .strict();

export const skillsSearchOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    skills: z.array(skillSearchItemSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export type SkillsSearchInput = z.infer<typeof skillsSearchInputSchema>;
export type SkillsSearchOutput = z.infer<typeof skillsSearchOutputSchema>;
