import { strToU8, zipSync, type Zippable } from "fflate";
import {
  canonicalSkillJson,
  stableJson,
  type SkillFileManifestEntry,
} from "../../src/manifest.js";
import { bytewisePathCompare } from "../../src/paths.js";
import { mediaTypeForPath, sha256Hex } from "../../src/validate.js";

export async function createTestBundle(
  files: Readonly<Record<string, string | Uint8Array>>,
  options: {
    readonly name?: string;
    readonly slug?: string;
    readonly description?: string;
    readonly tags?: readonly string[];
    readonly order?: readonly string[];
    readonly mtime?: Date;
  } = {},
): Promise<Uint8Array> {
  const contents = new Map<string, Uint8Array>();
  for (const [path, content] of Object.entries(files)) {
    contents.set(path, typeof content === "string" ? strToU8(content) : content);
  }
  if (!contents.has("SKILL.md")) {
    contents.set("SKILL.md", strToU8("# Test skill\n"));
  }
  const manifest: SkillFileManifestEntry[] = [];
  for (const [path, content] of contents) {
    manifest.push({
      path,
      sha256: await sha256Hex(content),
      byteSize: content.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  manifest.sort((left, right) => bytewisePathCompare(left.path, right.path));
  const skill = canonicalSkillJson({
    formatVersion: 1,
    name: options.name ?? "Test skill",
    slug: options.slug ?? "test-skill",
    description: options.description ?? "A deterministic test skill",
    tags: [...(options.tags ?? ["testing"])],
    entrypoint: "SKILL.md",
    files: manifest,
  });
  contents.set("skill.json", strToU8(`${stableJson(skill)}\n`));
  const paths = options.order?.filter((path) => contents.has(path)) ?? [
    ...contents.keys(),
  ];
  const missing = [...contents.keys()].filter((path) => !paths.includes(path));
  const zippable: Zippable = {};
  for (const path of [...paths, ...missing]) {
    const content = contents.get(path);
    if (!content) continue;
    zippable[path] = [
      content,
      {
        attrs: 0o100644 << 16,
        level: 6,
        mtime: options.mtime ?? new Date("2024-03-05T12:34:00Z"),
        os: 3,
      },
    ];
  }
  return zipSync(zippable, { level: 6 });
}
