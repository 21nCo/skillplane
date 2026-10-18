import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createTestBundle } from "../tests/support/bundle-fixture.js";
import { canonicalizeBundle, canonicalizeBundleFiles } from "./canonicalize.js";
import { retrieveBundleFile } from "./downloads.js";
import {
  bundleEntrypoint,
  bundleKind,
  skillJsonSchema,
  stableJson,
  type SkillFileManifestEntry,
} from "./manifest.js";
import { BundlePathError, bytewisePathCompare, normalizeBundlePath } from "./paths.js";
import type { R2BundleRepository } from "./r2.js";
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

  it("serves a root AGENTS.md only from an instructions artifact", async () => {
    const bundle = await canonicalizeBundleFiles({
      skill: { ...instructionsHeader, ...identity, tags: [...identity.tags] },
      files: new Map([["AGENTS.md", strToU8("# Agents\n\nRun the tests.\n")]]),
    });
    let reads = 0;
    const repository = {
      getCanonicalBundle: async () => {
        reads += 1;
        return { bytes: bundle.bytes };
      },
    } as unknown as R2BundleRepository;
    const target = {
      repository,
      objectKey: "bundle",
      bundleDigest: bundle.digest,
      path: "AGENTS.md",
    };
    await expect(retrieveBundleFile(target)).rejects.toBeInstanceOf(BundlePathError);
    await expect(
      retrieveBundleFile({ ...target, kind: "skill" }),
    ).rejects.toBeInstanceOf(BundlePathError);
    expect(reads).toBe(0);
    const file = await retrieveBundleFile({ ...target, kind: "instructions" });
    expect(file).toMatchObject({
      path: "AGENTS.md",
      mediaType: bundle.manifest.files[0]?.mediaType,
      sha256: bundle.manifest.files[0]?.sha256,
    });
  });

  it("keeps AGENTS.md out of skill bundles and instructions out of skill metadata", async () => {
    await expect(
      validateBundleArchive(
        await createTestBundle({ "SKILL.md": "# Skill\n", "AGENTS.md": "# Agents\n" }),
      ),
    ).rejects.toMatchObject({
      name: "BundleValidationError",
      code: "SKILL_PATH_INVALID",
    });
    // Skill paths reject AGENTS.md up front; only instructions opt in.
    expect(() => normalizeBundlePath("AGENTS.md")).toThrow(BundlePathError);
    expect(
      normalizeBundlePath("AGENTS.md", false, { allowInstructionsEntrypoint: true }),
    ).toBe("AGENTS.md");
    await expect(
      canonicalizeBundleFiles({
        skill: { formatVersion: 1, entrypoint: "SKILL.md", ...identity, tags: [] },
        files: new Map([
          ["SKILL.md", strToU8("# Skill\n")],
          ["AGENTS.md", strToU8("# Agents\n")],
        ]),
      }),
    ).rejects.toBeInstanceOf(BundlePathError);
    // Git imports parse repository metadata with the skill-only schema.
    expect(
      skillJsonSchema.safeParse({ ...instructionsHeader, ...identity, files: [] })
        .success,
    ).toBe(false);
  });
});
