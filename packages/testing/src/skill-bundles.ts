import {
  bytewisePathCompare,
  canonicalSkillJson,
  mediaTypeForPath,
  sha256Hex,
  stableJson,
  type SkillFileManifestEntry,
} from "@skillplane/storage";
import { strToU8, zipSync, type Zippable } from "fflate";

export async function createSkillBundleFixture(options: {
  readonly name: string;
  readonly slug: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly skillMarkdown: string;
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
}): Promise<Uint8Array> {
  const contents = new Map<string, Uint8Array>([
    ["SKILL.md", strToU8(options.skillMarkdown)],
  ]);
  for (const [path, value] of Object.entries(options.files ?? {})) {
    if (path === "skill.json") {
      throw new Error("The skill.json fixture is generated from the file inventory");
    }
    contents.set(path, typeof value === "string" ? strToU8(value) : value);
  }
  const files: SkillFileManifestEntry[] = [];
  for (const [path, bytes] of contents) {
    files.push({
      path,
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  files.sort((left, right) => bytewisePathCompare(left.path, right.path));
  const skill = canonicalSkillJson({
    formatVersion: 1,
    name: options.name,
    slug: options.slug,
    description: options.description ?? "",
    tags: [...(options.tags ?? [])],
    entrypoint: "SKILL.md",
    files,
  });
  const archive: Zippable = {};
  for (const [path, bytes] of [
    ...contents,
    ["skill.json", strToU8(`${stableJson(skill)}\n`)] as const,
  ]) {
    archive[path] = [
      bytes,
      {
        attrs: 0o100644 << 16,
        level: 6,
        mtime: new Date("2026-01-01T00:00:00Z"),
        os: 3,
      },
    ];
  }
  return zipSync(archive, { level: 6 });
}
