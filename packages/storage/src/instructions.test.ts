import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createTestBundle } from "../tests/support/bundle-fixture.js";
import { canonicalizeBundle, canonicalizeBundleFiles } from "./canonicalize.js";
import {
  bundleEntrypoint,
  bundleKind,
  skillJsonSchema,
  stableJson,
  type SkillFileManifestEntry,
} from "./manifest.js";
import { bytewisePathCompare } from "./paths.js";
import { mediaTypeForPath, sha256Hex, validateBundleArchive } from "./validate.js";

const identity = {
  name: "Repository agents",
  slug: "repository-agents",
  description: "Shared guidance",
  tags: ["agents"],
} as const;

// Builds a ZIP whose skill.json inventory matches its files, so validation
// reaches the instructions rules instead of failing the inventory check.
async function archive(
  files: Readonly<Record<string, string>>,
  header: Readonly<Record<string, unknown>>,
): Promise<Uint8Array> {
  const manifest: SkillFileManifestEntry[] = [];
  for (const [path, content] of Object.entries(files)) {
    const bytes = strToU8(content);
    manifest.push({
      path,
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  manifest.sort((left, right) => bytewisePathCompare(left.path, right.path));
  return zipSync({
    ...Object.fromEntries(
      Object.entries(files).map(([path, content]) => [path, strToU8(content)]),
    ),
    "skill.json": strToU8(stableJson({ ...identity, ...header, files: manifest })),
  });
}

const instructionsHeader = {
  formatVersion: 1,
  kind: "instructions",
  entrypoint: "AGENTS.md",
} as const;

describe("instructions bundles", () => {
  it("canonicalizes a single AGENTS.md as the instructions kind", async () => {
    const bundle = await canonicalizeBundleFiles({
      skill: { ...instructionsHeader, ...identity, tags: [...identity.tags] },
      files: new Map([["AGENTS.md", strToU8("# Agents\n\nRun the tests.\n")]]),
    });
    expect(bundleKind(bundle.skill)).toBe("instructions");
    expect(bundleEntrypoint(bundle.skill)).toBe("AGENTS.md");
    expect(bundle.manifest.formatVersion).toBe(1);
    expect(bundle.manifest.files.map((file) => file.path)).toEqual([
      "AGENTS.md",
      "skill.json",
    ]);
    const again = await canonicalizeBundle(bundle.bytes);
    expect(again.digest).toBe(bundle.digest);
    expect(again.skill).toEqual(bundle.skill);
  });

  it("is never interchangeable with a skill bundle", async () => {
    const document = "# Agents\n";
    await expect(
      validateBundleArchive(
        await archive(
          { "AGENTS.md": document, "references/a.md": "a" },
          instructionsHeader,
        ),
      ),
    ).rejects.toMatchObject({ code: "SKILL_BUNDLE_INVALID" });
    await expect(
      validateBundleArchive(
        await archive(
          { "AGENTS.md": document, "SKILL.md": document },
          instructionsHeader,
        ),
      ),
    ).rejects.toMatchObject({ code: "SKILL_PATH_INVALID" });
    await expect(
      validateBundleArchive(
        await archive({ "SKILL.md": document }, instructionsHeader),
      ),
    ).rejects.toMatchObject({ code: "SKILL_BUNDLE_INVALID" });
    await expect(
      validateBundleArchive(
        await archive(
          { "AGENTS.md": document },
          { formatVersion: 1, entrypoint: "SKILL.md" },
        ),
      ),
    ).rejects.toMatchObject({ code: "SKILL_BUNDLE_INVALID" });
    await expect(
      validateBundleArchive(await archive({ "AGENTS.md": " \n" }, instructionsHeader)),
    ).rejects.toMatchObject({ code: "SKILL_BUNDLE_INVALID" });
    await expect(
      validateBundleArchive(
        await archive({ "AGENTS.md": "a".repeat(1024 * 1024 + 1) }, instructionsHeader),
      ),
    ).rejects.toMatchObject({ code: "SKILL_BUNDLE_TOO_LARGE" });
  });

  it("keeps AGENTS.md out of skill bundles and instructions out of skill metadata", async () => {
    await expect(
      validateBundleArchive(
        await createTestBundle({ "SKILL.md": "# Skill\n", "AGENTS.md": "# Agents\n" }),
      ),
    ).rejects.toMatchObject({ code: "SKILL_PATH_INVALID" });
    // Git imports parse repository metadata with the skill-only schema.
    expect(
      skillJsonSchema.safeParse({ ...instructionsHeader, ...identity, files: [] })
        .success,
    ).toBe(false);
  });
});
