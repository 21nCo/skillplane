import { canonicalizeBundleFiles, type SkillDependency, type CanonicalBundle } from "@skillplane/storage";

/** Shared initial immutable bundle construction for local, API and MCP adapters. */
export function createSkillBundle(input: {
  composition?: { dependencies: readonly SkillDependency[]; verify: boolean; blocking: boolean };
  name: string;
  slug: string;
  description: string;
  tags: string[];
  instructions: string;
  assets: readonly {
    path: string;
    content?: string | undefined;
    contentBase64?: string | undefined;
  }[];
}): Promise<CanonicalBundle> {
  if (input.composition?.blocking && !input.composition.verify) throw new Error("blocking requires verification");
  const files = new Map<string, Uint8Array>([
    ["SKILL.md", new TextEncoder().encode(input.instructions)],
  ]);
  for (const asset of input.assets) {
    if (files.has(asset.path) || asset.path === "skill.json")
      throw new Error("SKILL_PATH_DUPLICATE");
    files.set(
      asset.path,
      asset.content !== undefined
        ? new TextEncoder().encode(asset.content)
        : Uint8Array.from(atob(asset.contentBase64 ?? ""), (c) => c.charCodeAt(0)),
    );
  }
  return canonicalizeBundleFiles({
    skill: {
      ...(input.composition ? {
        formatVersion: 2 as const,
        entrypoints: { execute: "SKILL.md" as const, ...(input.composition.verify ? { verify: "verification/VERIFY.md" as const } : {}) },
        dependencies: [...input.composition.dependencies],
        ...(input.composition.verify ? { verification: { claims: "verification/claims.json" as const, blocking: input.composition.blocking } } : {}),
      } : { formatVersion: 1 as const, entrypoint: "SKILL.md" as const }),
      name: input.name,
      slug: input.slug,
      description: input.description,
      tags: input.tags,
    },
    files,
  });
}
