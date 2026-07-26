import { z } from "zod";

function containsNoControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined || codePoint < 32 || codePoint === 127) {
      return false;
    }
  }
  return true;
}

export function declaredText(label: string, maximum: number) {
  return z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(maximum, `${label} is too long`)
    .refine(containsNoControlCharacters, `${label} contains control characters`);
}

export const stableIdSchema = declaredText("Identifier", 200);
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
export const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const fileDigestSchema = z.string().regex(/^[a-f0-9]{64}$/u);
export const timestampSchema = z.iso.datetime({ offset: true });
export const opaqueCursorSchema = z.string().min(32).max(4_096);
export const nullableCursorSchema = opaqueCursorSchema.nullable().default(null);
export const limitSchema = z.number().int().min(1).max(100).default(20);

export const skillSelectorSchema = z.union([
  z.object({ id: stableIdSchema }).strict(),
  z
    .object({
      workspaceSlug: slugSchema,
      skillSlug: slugSchema,
    })
    .strict(),
]);

export const versionSelectorSchema = z.discriminatedUnion("selector", [
  z.object({ selector: z.literal("current") }).strict(),
  z
    .object({
      selector: z.literal("versionId"),
      versionId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      selector: z.literal("semanticVersion"),
      semanticVersion: z
        .string()
        .trim()
        .min(1)
        .max(160)
        .regex(
          /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
        ),
    })
    .strict(),
  z
    .object({
      selector: z.literal("revision"),
      revision: z.number().int().positive(),
    })
    .strict(),
]);

export const contextSelectorSchema = z.union([
  z.object({ id: stableIdSchema }).strict(),
  z.object({ slug: slugSchema }).strict(),
]);

export const knowledgeSelectorSchema = z.discriminatedUnion("selector", [
  z.object({ selector: z.literal("current") }).strict(),
  z
    .object({
      selector: z.literal("revisionId"),
      revisionId: stableIdSchema,
    })
    .strict(),
  z
    .object({
      selector: z.literal("revision"),
      revision: z.number().int().positive(),
    })
    .strict(),
]);

export const skillVisibilitySchema = z.enum(["private", "workspace", "public"]);
export const versionStateSchema = z.enum([
  "draft",
  "pending_review",
  "published",
  "rejected",
]);
export const noteStateSchema = z.enum(["active", "archived", "all"]);

export const fileDescriptorSchema = z
  .object({
    path: z.string().min(1).max(240),
    sha256: fileDigestSchema,
    byteSize: z.number().int().nonnegative(),
    mediaType: z.string().min(1).max(160),
  })
  .strict();

export const manifestSchema = z
  .object({
    formatVersion: z.literal(1),
    digest: digestSchema,
    byteSize: z.number().int().nonnegative(),
    expandedByteSize: z.number().int().nonnegative(),
    fileCount: z.number().int().nonnegative(),
    files: z.array(fileDescriptorSchema).max(1_000),
  })
  .strict();

export const callerTrustSchema = z.literal("caller-declared");

export type SkillSelector = z.infer<typeof skillSelectorSchema>;
export type VersionSelector = z.infer<typeof versionSelectorSchema>;
export type ContextSelector = z.infer<typeof contextSelectorSchema>;
export type KnowledgeSelector = z.infer<typeof knowledgeSelectorSchema>;
