const encoder = new TextEncoder();

const ROOT_FILES = new Set(["SKILL.md", "skill.json"]);
const OPTIONAL_ROOTS = new Set(["assets", "references", "scripts"]);

export type BundlePathErrorCode =
  "SKILL_PATH_INVALID" | "SKILL_PATH_DUPLICATE" | "SKILL_LINK_INVALID";

export class BundlePathError extends Error {
  readonly code: BundlePathErrorCode;

  constructor(code: BundlePathErrorCode, message: string) {
    super(message);
    this.name = "BundlePathError";
    this.code = code;
  }
}

export function normalizeBundlePath(input: string, directory = false): string {
  if (!input || input.includes("\0") || input.includes("\\")) {
    throw new BundlePathError("SKILL_PATH_INVALID", "Bundle path is invalid");
  }
  const normalized = input.normalize("NFC");
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:/.test(normalized) ||
    normalized.startsWith("//")
  ) {
    throw new BundlePathError("SKILL_PATH_INVALID", "Absolute paths are forbidden");
  }

  const withoutDirectorySuffix =
    directory && normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
  const segments = withoutDirectorySuffix.split("/");
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment.length === 0 || segment === "." || segment === ".." || segment === "~",
    )
  ) {
    throw new BundlePathError(
      "SKILL_PATH_INVALID",
      "Empty and traversing path segments are forbidden",
    );
  }
  if (encoder.encode(withoutDirectorySuffix).byteLength > 240) {
    throw new BundlePathError("SKILL_PATH_INVALID", "Bundle path is too long");
  }

  const [root] = segments;
  if (
    (!directory && segments.length === 1 && !ROOT_FILES.has(withoutDirectorySuffix)) ||
    (segments.length > 1 && !OPTIONAL_ROOTS.has(root ?? "")) ||
    (directory && !OPTIONAL_ROOTS.has(root ?? ""))
  ) {
    throw new BundlePathError(
      "SKILL_PATH_INVALID",
      "Bundle path uses an unsupported top-level entry",
    );
  }
  if (!directory && OPTIONAL_ROOTS.has(withoutDirectorySuffix)) {
    throw new BundlePathError(
      "SKILL_PATH_INVALID",
      "Optional bundle roots must be directories",
    );
  }
  return withoutDirectorySuffix;
}

export function bundlePathCollisionKey(path: string): string {
  return path.normalize("NFC").toLowerCase();
}

export function bytewisePathCompare(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function assertStorageIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9:_-]{1,160}$/.test(value)) {
    throw new BundlePathError(
      "SKILL_PATH_INVALID",
      `${label} is not safe for an object key`,
    );
  }
  return value;
}
