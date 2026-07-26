import { z } from "zod";

export const SKILL_BUNDLE_FORMAT_VERSION = 1 as const;

export const fileManifestEntrySchema = z
  .object({
    path: z.string().min(1).max(240),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byteSize: z
      .number()
      .int()
      .min(0)
      .max(5 * 1024 * 1024),
    mediaType: z.string().min(1).max(160),
  })
  .strict();

export const skillJsonSchema = z
  .object({
    formatVersion: z.literal(SKILL_BUNDLE_FORMAT_VERSION),
    name: z.string().trim().min(1).max(160),
    slug: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().max(20_000),
    tags: z.array(z.string().trim().min(1).max(80)).max(30),
    entrypoint: z.literal("SKILL.md"),
    files: z.array(fileManifestEntrySchema).min(1).max(999),
  })
  .strict();

export type SkillJson = z.infer<typeof skillJsonSchema>;
export type SkillFileManifestEntry = z.infer<typeof fileManifestEntrySchema>;

export interface BundleManifest {
  readonly formatVersion: typeof SKILL_BUNDLE_FORMAT_VERSION;
  readonly digest: `sha256:${string}`;
  readonly byteSize: number;
  readonly expandedByteSize: number;
  readonly fileCount: number;
  readonly files: readonly SkillFileManifestEntry[];
}

export interface CanonicalBundle {
  readonly bytes: Uint8Array;
  readonly digest: `sha256:${string}`;
  readonly manifest: BundleManifest;
  readonly skill: SkillJson;
  readonly files: ReadonlyMap<string, Uint8Array>;
}

export function canonicalSkillJson(
  value: Omit<SkillJson, "files"> & {
    readonly files: readonly SkillFileManifestEntry[];
  },
): SkillJson {
  return {
    formatVersion: SKILL_BUNDLE_FORMAT_VERSION,
    name: value.name.trim(),
    slug: value.slug.trim(),
    description: value.description,
    tags: [...new Set(value.tags.map((tag) => tag.trim()))].sort((left, right) =>
      left.localeCompare(right, "en"),
    ),
    entrypoint: "SKILL.md",
    files: [...value.files],
  };
}

export function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  throw new TypeError("Only JSON-compatible values can be serialized");
}
