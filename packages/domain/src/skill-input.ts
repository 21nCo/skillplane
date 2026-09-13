import { canonicalizeBundleFiles, type CanonicalBundle } from "@skillplane/storage";

/** Shared initial immutable bundle construction for local, API and MCP adapters. */
export function createSkillBundle(input: {
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
      formatVersion: 1,
      name: input.name,
      slug: input.slug,
      description: input.description,
      tags: input.tags,
      entrypoint: "SKILL.md",
    },
    files,
  });
}
