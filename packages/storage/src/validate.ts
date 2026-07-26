import { Unzip, UnzipInflate } from "fflate";
import {
  canonicalSkillJson,
  fileManifestEntrySchema,
  skillJsonSchema,
  type SkillFileManifestEntry,
  type SkillJson,
} from "./manifest.js";
import {
  BundlePathError,
  bundlePathCollisionKey,
  bytewisePathCompare,
  normalizeBundlePath,
} from "./paths.js";

export const BUNDLE_LIMITS = {
  compressedBytes: 10 * 1024 * 1024,
  expandedBytes: 25 * 1024 * 1024,
  fileBytes: 5 * 1024 * 1024,
  skillMarkdownBytes: 1024 * 1024,
  files: 1000,
  entries: 1100,
  expansionRatio: 1000,
} as const;

export type BundleValidationErrorCode =
  | "SKILL_BUNDLE_INVALID"
  | "SKILL_BUNDLE_TOO_LARGE"
  | "SKILL_PATH_INVALID"
  | "SKILL_PATH_DUPLICATE"
  | "SKILL_LINK_INVALID";

export class BundleValidationError extends Error {
  readonly code: BundleValidationErrorCode;

  constructor(code: BundleValidationErrorCode, message: string) {
    super(message);
    this.name = "BundleValidationError";
    this.code = code;
  }
}

interface CentralEntry {
  readonly rawName: Uint8Array;
  readonly name: string;
  readonly path: string;
  readonly directory: boolean;
  readonly compressedSize: number;
  readonly originalSize: number;
  readonly compression: number;
  readonly localHeaderOffset: number;
}

export interface ValidatedBundle {
  readonly skill: SkillJson;
  readonly files: ReadonlyMap<string, Uint8Array>;
  readonly fileManifest: readonly SkillFileManifestEntry[];
  readonly expandedByteSize: number;
}

function fail(code: BundleValidationErrorCode, message: string): never {
  throw new BundleValidationError(code, message);
}

function readU16(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    fail("SKILL_BUNDLE_INVALID", "ZIP structure is truncated");
  }
  return (bytes[offset] ?? 0) | ((bytes[offset + 1] ?? 0) << 8);
}

function readU32(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    fail("SKILL_BUNDLE_INVALID", "ZIP structure is truncated");
  }
  return (
    ((bytes[offset] ?? 0) |
      ((bytes[offset + 1] ?? 0) << 8) |
      ((bytes[offset + 2] ?? 0) << 16) |
      ((bytes[offset + 3] ?? 0) << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(bytes: Uint8Array): number {
  const minimumOffset = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= minimumOffset; offset -= 1) {
    if (readU32(bytes, offset) === 0x06054b50) return offset;
  }
  return fail("SKILL_BUNDLE_INVALID", "ZIP central directory was not found");
}

function decodeName(rawName: Uint8Array, utf8: boolean): string {
  if (!utf8 && rawName.some((byte) => byte > 0x7f)) {
    return fail(
      "SKILL_PATH_INVALID",
      "Non-ASCII ZIP paths must declare UTF-8 encoding",
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawName);
  } catch {
    return fail("SKILL_PATH_INVALID", "ZIP path is not valid UTF-8");
  }
}

function hasLinkExtra(extra: Uint8Array): boolean {
  let offset = 0;
  while (offset < extra.length) {
    if (offset + 4 > extra.length) {
      fail("SKILL_BUNDLE_INVALID", "ZIP extra field is truncated");
    }
    const identifier = readU16(extra, offset);
    const size = readU16(extra, offset + 2);
    offset += 4;
    if (offset + size > extra.length) {
      fail("SKILL_BUNDLE_INVALID", "ZIP extra field is truncated");
    }
    // PKWARE UNIX and ASi UNIX fields can preserve link targets and device data.
    if (identifier === 0x000d || identifier === 0x756e) return true;
    offset += size;
  }
  return false;
}

function inspectCentralDirectory(bytes: Uint8Array): readonly CentralEntry[] {
  if (bytes.byteLength > BUNDLE_LIMITS.compressedBytes) {
    return fail("SKILL_BUNDLE_TOO_LARGE", "Compressed bundle exceeds 10 MiB");
  }
  const eocd = findEndOfCentralDirectory(bytes);
  const diskNumber = readU16(bytes, eocd + 4);
  const centralDisk = readU16(bytes, eocd + 6);
  const entriesOnDisk = readU16(bytes, eocd + 8);
  const entryCount = readU16(bytes, eocd + 10);
  const centralSize = readU32(bytes, eocd + 12);
  const centralOffset = readU32(bytes, eocd + 16);
  const commentLength = readU16(bytes, eocd + 20);
  if (
    diskNumber !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === 0xffff ||
    centralSize === 0xffffffff ||
    centralOffset === 0xffffffff
  ) {
    return fail("SKILL_BUNDLE_INVALID", "Multi-disk and ZIP64 bundles are unsupported");
  }
  if (
    entryCount > BUNDLE_LIMITS.entries ||
    eocd + 22 + commentLength !== bytes.length ||
    centralOffset + centralSize !== eocd
  ) {
    return fail("SKILL_BUNDLE_INVALID", "ZIP directory bounds are invalid");
  }

  const entries: CentralEntry[] = [];
  const paths = new Set<string>();
  let fileCount = 0;
  let expandedBytes = 0;
  let offset = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (readU32(bytes, offset) !== 0x02014b50) {
      return fail("SKILL_BUNDLE_INVALID", "ZIP central entry is invalid");
    }
    const versionMadeBy = readU16(bytes, offset + 4);
    const flags = readU16(bytes, offset + 8);
    const compression = readU16(bytes, offset + 10);
    const compressedSize = readU32(bytes, offset + 20);
    const originalSize = readU32(bytes, offset + 24);
    const nameLength = readU16(bytes, offset + 28);
    const extraLength = readU16(bytes, offset + 30);
    const entryCommentLength = readU16(bytes, offset + 32);
    const diskStart = readU16(bytes, offset + 34);
    const externalAttributes = readU32(bytes, offset + 38);
    const localHeaderOffset = readU32(bytes, offset + 42);
    const end = offset + 46 + nameLength + extraLength + entryCommentLength;
    if (end > eocd || nameLength === 0 || diskStart !== 0) {
      return fail("SKILL_BUNDLE_INVALID", "ZIP central entry bounds are invalid");
    }
    if ((flags & 0x1) !== 0 || (flags & 0x40) !== 0) {
      return fail("SKILL_BUNDLE_INVALID", "Encrypted ZIP entries are unsupported");
    }
    if (compression !== 0 && compression !== 8) {
      return fail(
        "SKILL_BUNDLE_INVALID",
        "Only stored and deflated ZIP entries are supported",
      );
    }
    const rawName = bytes.slice(offset + 46, offset + 46 + nameLength);
    const name = decodeName(rawName, (flags & 0x800) !== 0);
    const directory = name.endsWith("/");
    const path = normalizeBundlePath(name, directory);
    const collisionKey = bundlePathCollisionKey(path);
    if (paths.has(collisionKey)) {
      return fail(
        "SKILL_PATH_DUPLICATE",
        "Bundle contains duplicate case-folded paths",
      );
    }
    paths.add(collisionKey);

    const host = versionMadeBy >>> 8;
    const unixMode = externalAttributes >>> 16;
    const fileType = unixMode & 0xf000;
    if (host === 3 && fileType !== 0 && fileType !== 0x8000 && fileType !== 0x4000) {
      return fail(
        "SKILL_LINK_INVALID",
        "Links, devices, pipes, and sockets are forbidden",
      );
    }
    const extra = bytes.slice(
      offset + 46 + nameLength,
      offset + 46 + nameLength + extraLength,
    );
    if (hasLinkExtra(extra)) {
      return fail("SKILL_LINK_INVALID", "Link-preserving ZIP metadata is forbidden");
    }
    if (directory) {
      if (originalSize !== 0) {
        return fail("SKILL_BUNDLE_INVALID", "Directory entries must be empty");
      }
    } else {
      fileCount += 1;
      expandedBytes += originalSize;
      if (
        fileCount > BUNDLE_LIMITS.files ||
        originalSize > BUNDLE_LIMITS.fileBytes ||
        expandedBytes > BUNDLE_LIMITS.expandedBytes ||
        (compressedSize === 0 && originalSize > 0) ||
        (compressedSize > 0 &&
          originalSize / compressedSize > BUNDLE_LIMITS.expansionRatio)
      ) {
        return fail("SKILL_BUNDLE_TOO_LARGE", "Bundle expansion limits exceeded");
      }
      if (path === "SKILL.md" && originalSize > BUNDLE_LIMITS.skillMarkdownBytes) {
        return fail("SKILL_BUNDLE_TOO_LARGE", "SKILL.md exceeds 1 MiB");
      }
    }

    if (
      readU32(bytes, localHeaderOffset) !== 0x04034b50 ||
      readU16(bytes, localHeaderOffset + 8) !== compression
    ) {
      return fail("SKILL_BUNDLE_INVALID", "ZIP local header is invalid");
    }
    const localNameLength = readU16(bytes, localHeaderOffset + 26);
    const localExtraLength = readU16(bytes, localHeaderOffset + 28);
    const localName = bytes.slice(
      localHeaderOffset + 30,
      localHeaderOffset + 30 + localNameLength,
    );
    if (
      localName.length !== rawName.length ||
      localName.some((byte, localIndex) => byte !== rawName[localIndex]) ||
      localHeaderOffset + 30 + localNameLength + localExtraLength + compressedSize >
        centralOffset
    ) {
      return fail(
        "SKILL_BUNDLE_INVALID",
        "ZIP local and central entries are inconsistent",
      );
    }
    entries.push({
      rawName,
      name,
      path,
      directory,
      compressedSize,
      originalSize,
      compression,
      localHeaderOffset,
    });
    offset = end;
  }
  if (offset !== eocd) {
    return fail("SKILL_BUNDLE_INVALID", "ZIP central directory is inconsistent");
  }
  return entries;
}

function extractFiles(
  bytes: Uint8Array,
  entries: readonly CentralEntry[],
): ReadonlyMap<string, Uint8Array> {
  const expected = new Map(
    entries.filter((entry) => !entry.directory).map((entry) => [entry.path, entry]),
  );
  const files = new Map<string, Uint8Array>();
  let extractionError: unknown;
  const unzip = new Unzip((file) => {
    try {
      const directory = file.name.endsWith("/");
      const path = normalizeBundlePath(file.name, directory);
      const entry = entries.find(
        (candidate) => candidate.path === path && candidate.directory === directory,
      );
      if (
        file.compression !== entry?.compression ||
        (file.originalSize !== undefined && file.originalSize !== entry.originalSize) ||
        (file.size !== undefined && file.size !== entry.compressedSize)
      ) {
        fail("SKILL_BUNDLE_INVALID", "ZIP extraction metadata is inconsistent");
      }
      const chunks: Uint8Array[] = [];
      let byteSize = 0;
      file.ondata = (error, chunk, final) => {
        if (extractionError) return;
        if (error) {
          extractionError = error;
          return;
        }
        byteSize += chunk.byteLength;
        if (
          byteSize > entry.originalSize ||
          byteSize > BUNDLE_LIMITS.fileBytes ||
          (path === "SKILL.md" && byteSize > BUNDLE_LIMITS.skillMarkdownBytes)
        ) {
          extractionError = new BundleValidationError(
            "SKILL_BUNDLE_TOO_LARGE",
            "Extracted entry exceeds declared limits",
          );
          file.terminate();
          return;
        }
        if (!directory && chunk.byteLength > 0) chunks.push(chunk.slice());
        if (final) {
          if (byteSize !== entry.originalSize) {
            extractionError = new BundleValidationError(
              "SKILL_BUNDLE_INVALID",
              "Extracted entry size does not match its directory record",
            );
            return;
          }
          if (!directory) {
            const content = new Uint8Array(byteSize);
            let offset = 0;
            for (const part of chunks) {
              content.set(part, offset);
              offset += part.byteLength;
            }
            files.set(path, content);
          }
        }
      };
      file.start();
    } catch (error) {
      extractionError = error;
      file.terminate();
    }
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length && !extractionError; offset += 64 * 1024) {
    unzip.push(
      bytes.subarray(offset, Math.min(offset + 64 * 1024, bytes.length)),
      offset + 64 * 1024 >= bytes.length,
    );
  }
  if (extractionError) {
    throw extractionError instanceof Error
      ? extractionError
      : new BundleValidationError("SKILL_BUNDLE_INVALID", "ZIP extraction failed");
  }
  if (
    files.size !== expected.size ||
    [...expected.keys()].some((path) => !files.has(path))
  ) {
    return fail("SKILL_BUNDLE_INVALID", "ZIP file inventory is incomplete");
  }
  return files;
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export function mediaTypeForPath(path: string): string {
  const extension = path.split(".").pop()?.toLowerCase();
  const known: Readonly<Record<string, string>> = {
    css: "text/css; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    gif: "image/gif",
    html: "text/html; charset=utf-8",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript; charset=utf-8",
    json: "application/json",
    md: "text/markdown; charset=utf-8",
    pdf: "application/pdf",
    png: "image/png",
    sh: "text/x-shellscript; charset=utf-8",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    webp: "image/webp",
    yaml: "application/yaml",
    yml: "application/yaml",
  };
  return known[extension ?? ""] ?? "application/octet-stream";
}

function parseSkillJson(bytes: Uint8Array): SkillJson {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("SKILL_BUNDLE_INVALID", "skill.json is not valid UTF-8");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(decoded);
  } catch {
    return fail("SKILL_BUNDLE_INVALID", "skill.json is not valid JSON");
  }
  const parsed = skillJsonSchema.safeParse(raw);
  if (!parsed.success) {
    return fail("SKILL_BUNDLE_INVALID", "skill.json does not match format version 1");
  }
  if (new TextEncoder().encode(parsed.data.description).byteLength > 20_000) {
    return fail("SKILL_BUNDLE_INVALID", "Skill description is too large");
  }
  if (new Set(parsed.data.tags).size !== parsed.data.tags.length) {
    return fail("SKILL_BUNDLE_INVALID", "Skill tags must be unique");
  }
  return parsed.data;
}

function assertUtf8Markdown(bytes: Uint8Array): void {
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (value.includes("\0") || value.trim().length === 0) {
      fail("SKILL_BUNDLE_INVALID", "SKILL.md must contain non-empty UTF-8 text");
    }
  } catch (error) {
    if (error instanceof BundleValidationError) throw error;
    fail("SKILL_BUNDLE_INVALID", "SKILL.md is not valid UTF-8");
  }
}

export async function validateBundleArchive(
  bytes: Uint8Array,
): Promise<ValidatedBundle> {
  let entries: readonly CentralEntry[];
  try {
    entries = inspectCentralDirectory(bytes);
  } catch (error) {
    if (error instanceof BundlePathError) {
      throw new BundleValidationError(error.code, error.message);
    }
    throw error;
  }
  const files = extractFiles(bytes, entries);
  const skillMarkdown = files.get("SKILL.md");
  const skillJsonBytes = files.get("skill.json");
  if (!skillMarkdown || !skillJsonBytes) {
    return fail(
      "SKILL_BUNDLE_INVALID",
      "Bundle must contain root SKILL.md and skill.json",
    );
  }
  assertUtf8Markdown(skillMarkdown);
  const skill = parseSkillJson(skillJsonBytes);
  const actualManifest: SkillFileManifestEntry[] = [];
  for (const [path, content] of files) {
    if (path === "skill.json") continue;
    actualManifest.push({
      path,
      sha256: await sha256Hex(content),
      byteSize: content.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  actualManifest.sort((left, right) => bytewisePathCompare(left.path, right.path));
  const declared = skill.files.map((entry) => fileManifestEntrySchema.parse(entry));
  if (
    declared.length !== actualManifest.length ||
    declared.some((entry, index) => {
      const actual = actualManifest[index];
      return (
        entry.path !== actual?.path ||
        entry.sha256 !== actual.sha256 ||
        entry.byteSize !== actual.byteSize ||
        entry.mediaType !== actual.mediaType
      );
    })
  ) {
    return fail(
      "SKILL_BUNDLE_INVALID",
      "skill.json file inventory does not match archive contents",
    );
  }
  return {
    skill: canonicalSkillJson({ ...skill, files: actualManifest }),
    files,
    fileManifest: actualManifest,
    expandedByteSize: [...files.values()].reduce(
      (total, content) => total + content.byteLength,
      0,
    ),
  };
}
