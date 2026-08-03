import { z } from "zod";
import { callerDeclarationSchema } from "./caller.js";
import {
  limitSchema,
  nullableCursorSchema,
  skillVisibilitySchema,
  slugSchema,
  stableIdSchema,
  timestampSchema,
  workspaceSelectorSchema,
} from "./common.js";

const workspaceKindSchema = z.enum(["personal", "organization"]);
const workspaceRoleSchema = z.enum(["viewer", "editor", "admin", "owner"]);
const skillArchiveFilterSchema = z.enum(["active", "archived", "all"]);

export const workspaceCatalogItemSchema = z
  .object({
    id: stableIdSchema,
    slug: slugSchema,
    name: z.string().min(1).max(120),
    kind: workspaceKindSchema,
    role: workspaceRoleSchema,
    updatedAt: timestampSchema,
  })
  .strict();

export const workspacesListInputSchema = z
  .object({
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const workspacesListOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    workspaces: z.array(workspaceCatalogItemSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

const listedCurrentVersionSchema = z
  .object({
    id: stableIdSchema,
    semanticVersion: z.string().min(1).max(160),
  })
  .strict();

export const listedSkillSchema = z
  .object({
    id: stableIdSchema,
    workspaceId: stableIdSchema,
    workspaceSlug: slugSchema,
    slug: slugSchema,
    name: z.string().min(1).max(160),
    summary: z.string().max(20_000),
    tags: z.array(z.string().max(80)).max(30),
    visibility: skillVisibilitySchema,
    currentVersion: listedCurrentVersionSchema.nullable(),
    archivedAt: timestampSchema.nullable(),
    updatedAt: timestampSchema,
  })
  .strict();

export const skillsListInputSchema = z
  .object({
    workspace: workspaceSelectorSchema,
    visibility: z
      .array(skillVisibilitySchema)
      .min(1)
      .max(3)
      .default(["private", "workspace", "public"]),
    state: skillArchiveFilterSchema.default("active"),
    cursor: nullableCursorSchema,
    limit: limitSchema,
    caller: callerDeclarationSchema,
  })
  .strict();

export const skillsListOutputSchema = z
  .object({
    requestId: z.string().min(1).max(200),
    workspace: workspaceCatalogItemSchema.omit({ role: true, updatedAt: true }),
    skills: z.array(listedSkillSchema).max(100),
    nextCursor: z.string().max(4_096).nullable(),
  })
  .strict();

export type WorkspaceSelector = z.infer<typeof workspaceSelectorSchema>;
export type WorkspaceCatalogItem = z.infer<typeof workspaceCatalogItemSchema>;
export type WorkspacesListInput = z.infer<typeof workspacesListInputSchema>;
export type WorkspacesListOutput = z.infer<typeof workspacesListOutputSchema>;
export type SkillsListInput = z.infer<typeof skillsListInputSchema>;
export type SkillsListOutput = z.infer<typeof skillsListOutputSchema>;
