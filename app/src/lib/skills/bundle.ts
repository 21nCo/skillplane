import { strToU8, unzipSync, zipSync, type Unzipped, type Zippable } from "fflate";

const encoder = new TextEncoder();
const CANONICAL_MTIME = new Date("1980-01-01T00:00:00.000Z");
const REGULAR_FILE_MODE = 0o100644 << 16;
const MAX_COMPRESSED_BYTES = 10 * 1024 * 1024;

export interface EditableSkillMetadata {
  readonly name: string;
  readonly slug: string;
  readonly description: string;
  readonly tags: readonly string[];
}

export interface InspectedSkillBundle extends EditableSkillMetadata {
  readonly formatVersion: 1;
  readonly fileCount: number;
}

function comparePaths(left: string, right: string): number {
  const leftBytes = encoder.encode(left.normalize("NFC"));
  const rightBytes = encoder.encode(right.normalize("NFC"));
  const limit = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < limit; index += 1) {
    const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function stableJson(value: unknown): string {
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

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const input = new Uint8Array(bytes.byteLength);
  input.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", input);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function mediaTypeForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLocaleLowerCase();
  const types: Readonly<Record<string, string>> = {
    css: "text/css; charset=utf-8",
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
    yaml: "application/yaml",
    yml: "application/yaml",
  };
  return extension ? (types[extension] ?? "application/octet-stream") : "text/plain";
}

function normalizeMetadata(metadata: EditableSkillMetadata): EditableSkillMetadata {
  const name = metadata.name.trim().replace(/\s+/gu, " ");
  const slug = metadata.slug.trim().toLocaleLowerCase();
  const tags = [...new Set(metadata.tags.map((tag) => tag.trim()).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .slice(0, 30);
  if (!name || name.length > 160) {
    throw new Error("Skill name must contain 1 to 160 characters.");
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 120) {
    throw new Error(
      "Skill slug must use lowercase letters, numbers, and single hyphens.",
    );
  }
  if (metadata.description.length > 20_000) {
    throw new Error("Description must be 20,000 characters or fewer.");
  }
  if (tags.some((tag) => tag.length > 80)) {
    throw new Error("Tags must be 80 characters or fewer.");
  }
  return { name, slug, description: metadata.description, tags };
}

export async function buildSkillBundle(options: {
  readonly metadata: EditableSkillMetadata;
  readonly files: ReadonlyMap<string, Uint8Array>;
}): Promise<Uint8Array> {
  const metadata = normalizeMetadata(options.metadata);
  const files = new Map([...options.files].filter(([path]) => path !== "skill.json"));
  const skillMarkdown = files.get("SKILL.md");
  if (!skillMarkdown || skillMarkdown.byteLength === 0) {
    throw new Error("SKILL.md is required and cannot be empty.");
  }
  const manifest = [];
  for (const [path, bytes] of [...files].sort(([left], [right]) =>
    comparePaths(left, right),
  )) {
    manifest.push({
      path,
      sha256: await sha256Hex(bytes),
      byteSize: bytes.byteLength,
      mediaType: mediaTypeForPath(path),
    });
  }
  const skillJson = {
    formatVersion: 1,
    ...metadata,
    entrypoint: "SKILL.md",
    files: manifest,
  };
  files.set("skill.json", strToU8(`${stableJson(skillJson)}\n`));
  const archive: Zippable = {};
  for (const [path, bytes] of [...files].sort(([left], [right]) =>
    comparePaths(left, right),
  )) {
    archive[path] = [
      bytes,
      {
        attrs: REGULAR_FILE_MODE,
        level: 6,
        mtime: CANONICAL_MTIME,
        os: 3,
      },
    ];
  }
  const output = zipSync(archive, {
    attrs: REGULAR_FILE_MODE,
    level: 6,
    mtime: CANONICAL_MTIME,
    os: 3,
  });
  if (output.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error("The compressed skill bundle exceeds 10 MiB.");
  }
  return output;
}

function requiredString(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > maxLength) {
    throw new Error(`${field} is missing or invalid.`);
  }
  return value;
}

export function inspectSkillBundle(bytes: Uint8Array): InspectedSkillBundle {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_COMPRESSED_BYTES) {
    throw new Error("Choose a non-empty ZIP bundle no larger than 10 MiB.");
  }
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("The selected file is not a readable ZIP bundle.");
  }
  if (!Object.hasOwn(files, "SKILL.md") || !Object.hasOwn(files, "skill.json")) {
    throw new Error("The bundle must contain root SKILL.md and skill.json files.");
  }
  let value: unknown;
  try {
    value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(files["skill.json"]),
    );
  } catch {
    throw new Error("skill.json must contain valid UTF-8 JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("skill.json must contain an object.");
  }
  const record = value as Record<string, unknown>;
  if (record.formatVersion !== 1 || !Array.isArray(record.files)) {
    throw new Error("skill.json must use Skillplane bundle format version 1.");
  }
  const tags = Array.isArray(record.tags)
    ? record.tags.filter((tag): tag is string => typeof tag === "string")
    : [];
  return {
    formatVersion: 1,
    name: requiredString(record.name, "Skill name", 160),
    slug: requiredString(record.slug, "Skill slug", 120),
    description: typeof record.description === "string" ? record.description : "",
    tags,
    fileCount: Object.keys(files).length,
  };
}

export function filesFromBundle(bytes: Uint8Array): ReadonlyMap<string, Uint8Array> {
  let files: Unzipped;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error("The stored skill bundle could not be read.");
  }
  return new Map(
    Object.entries(files).map(([path, contents]) => [path, contents] as const),
  );
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  const chunkSize = 32_768;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    parts.push(String.fromCharCode(...chunk));
  }
  return btoa(parts.join(""));
}

export function markdownFiles(markdown: string): ReadonlyMap<string, Uint8Array> {
  return new Map([["SKILL.md", strToU8(markdown)]]);
}
