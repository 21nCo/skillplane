import { zipSync, type Zippable } from "fflate";
import {
  canonicalSkillJson,
  stableJson,
  type BundleManifest,
  type CanonicalBundle,
  type SkillFileManifestEntry,
  type SkillJson,
} from "./manifest.js";
import {
  bundlePathCollisionKey,
  bytewisePathCompare,
  normalizeBundlePath,
} from "./paths.js";
import {
  BUNDLE_LIMITS,
  BundleValidationError,
  mediaTypeForPath,
  sha256Hex,
  validateBundleArchive,
} from "./validate.js";

const CANONICAL_MTIME = new Date("1980-01-01T00:00:00.000Z");
const REGULAR_FILE_MODE = 0o100644 << 16;
const encoder = new TextEncoder();

export async function canonicalizeBundle(
  archiveBytes: Uint8Array,
): Promise<CanonicalBundle> {
  const validated = await validateBundleArchive(archiveBytes);
  const canonicalFiles = new Map(validated.files);
  const normalizedSkill = canonicalSkillJson({
    ...validated.skill,
    files: validated.fileManifest,
  });
  canonicalFiles.set("skill.json", encoder.encode(`${stableJson(normalizedSkill)}\n`));

  const paths = [...canonicalFiles.keys()].sort(bytewisePathCompare);
  const zippable: Zippable = {};
  for (const path of paths) {
    const content = canonicalFiles.get(path);
    if (!content) continue;
    zippable[path] = [
      content,
      {
        attrs: REGULAR_FILE_MODE,
        level: 9,
        mtime: CANONICAL_MTIME,
        os: 3,
      },
    ];
  }
  const bytes = zipSync(zippable, {
    attrs: REGULAR_FILE_MODE,
    level: 9,
    mtime: CANONICAL_MTIME,
    os: 3,
  });
  if (bytes.byteLength > BUNDLE_LIMITS.compressedBytes) {
    throw new BundleValidationError(
      "SKILL_BUNDLE_TOO_LARGE",
      "Canonical bundle exceeds 10 MiB",
    );
  }
  const digestHex = await sha256Hex(bytes);
  const files: SkillFileManifestEntry[] = [];
  for (const path of paths) {
    const content = canonicalFiles.get(path);
    if (!content) continue;
    files.push({
      path,
      sha256: await sha256Hex(content),
      byteSize: content.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  const expandedByteSize = files.reduce((total, file) => total + file.byteSize, 0);
  const digest = `sha256:${digestHex}` as const;
  const manifest: BundleManifest = {
    formatVersion: 1,
    digest,
    byteSize: bytes.byteLength,
    expandedByteSize,
    fileCount: files.length,
    files,
  };
  return {
    bytes,
    digest,
    manifest,
    skill: normalizedSkill,
    files: canonicalFiles,
  };
}

/**
 * Builds and validates a canonical bundle from an already-extracted file set.
 * `skill.json` is always regenerated from the immutable skill identity and the
 * resulting inventory, so a caller cannot smuggle metadata changes through a
 * file amendment.
 */
export async function canonicalizeBundleFiles(options: {
  readonly skill: Omit<SkillJson, "files">;
  readonly files: ReadonlyMap<string, Uint8Array>;
}): Promise<CanonicalBundle> {
  const contentFiles = new Map<string, Uint8Array>();
  const collisionKeys = new Set<string>();
  for (const [rawPath, rawContent] of options.files) {
    const path = normalizeBundlePath(rawPath);
    if (path === "skill.json") continue;
    const collisionKey = bundlePathCollisionKey(path);
    if (collisionKeys.has(collisionKey)) {
      throw new BundleValidationError(
        "SKILL_PATH_DUPLICATE",
        "Bundle contains duplicate case-folded paths",
      );
    }
    collisionKeys.add(collisionKey);
    const content = new Uint8Array(rawContent.byteLength);
    content.set(rawContent);
    contentFiles.set(path, content);
  }
  const manifestFiles: SkillFileManifestEntry[] = [];
  for (const [path, content] of contentFiles) {
    manifestFiles.push({
      path,
      sha256: await sha256Hex(content),
      byteSize: content.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  manifestFiles.sort((left, right) => bytewisePathCompare(left.path, right.path));
  const skill = canonicalSkillJson({ ...options.skill, files: manifestFiles });
  const archiveFiles = new Map(contentFiles);
  archiveFiles.set("skill.json", encoder.encode(`${stableJson(skill)}\n`));
  const zippable: Zippable = {};
  for (const path of [...archiveFiles.keys()].sort(bytewisePathCompare)) {
    const content = archiveFiles.get(path);
    if (!content) continue;
    zippable[path] = [
      content,
      {
        attrs: REGULAR_FILE_MODE,
        level: 9,
        mtime: CANONICAL_MTIME,
        os: 3,
      },
    ];
  }
  return canonicalizeBundle(
    zipSync(zippable, {
      attrs: REGULAR_FILE_MODE,
      level: 9,
      mtime: CANONICAL_MTIME,
      os: 3,
    }),
  );
}
