import { normalizeBundlePath } from "./paths.js";
import type { R2BundleRepository } from "./r2.js";
import { sha256Hex, validateBundleArchive } from "./validate.js";

export interface DownloadedSkillFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
  readonly mediaType: string;
  readonly bundleDigest: `sha256:${string}`;
}

export async function retrieveBundleFile(options: {
  readonly repository: R2BundleRepository;
  readonly objectKey: string;
  readonly bundleDigest: `sha256:${string}`;
  readonly path: string;
  readonly expectedFileDigest?: string;
}): Promise<DownloadedSkillFile> {
  const path = normalizeBundlePath(options.path);
  const { bytes } = await options.repository.getCanonicalBundle(
    options.objectKey,
    options.bundleDigest,
  );
  const bundle = await validateBundleArchive(bytes);
  const content = bundle.files.get(path);
  const manifest = bundle.fileManifest.find((file) => file.path === path);
  if (!content || (!manifest && path !== "skill.json")) {
    throw new Error("SKILL_FILE_NOT_FOUND");
  }
  const sha256 = await sha256Hex(content);
  if (
    (manifest && manifest.sha256 !== sha256) ||
    (options.expectedFileDigest && options.expectedFileDigest !== sha256)
  ) {
    throw new Error("SKILL_FILE_DIGEST_MISMATCH");
  }
  return {
    path,
    bytes: content,
    sha256,
    mediaType: manifest?.mediaType ?? "application/json",
    bundleDigest: options.bundleDigest,
  };
}

export function skillFileResponse(
  file: DownloadedSkillFile,
  options: {
    readonly publicImmutable: boolean;
    readonly ifNoneMatch?: string;
    readonly download?: boolean;
  },
): Response {
  const etag = `"sha256-${file.sha256}"`;
  const headers = new Headers({
    "Cache-Control": options.publicImmutable
      ? "public, max-age=31536000, immutable"
      : "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Content-Type": file.mediaType,
    "Cross-Origin-Resource-Policy": "same-origin",
    ETag: etag,
    "X-Content-Type-Options": "nosniff",
  });
  const activeContent =
    file.mediaType === "image/svg+xml" ||
    file.mediaType === "application/pdf" ||
    file.mediaType.startsWith("text/html") ||
    file.mediaType.startsWith("text/javascript");
  if (options.download || activeContent) {
    const filename = file.path.split("/").pop() ?? "skill-file";
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    );
  }
  if (options.ifNoneMatch === etag) {
    return new Response(null, { status: 304, headers });
  }
  const body = new Uint8Array(file.bytes.byteLength);
  body.set(file.bytes);
  return new Response(body, { status: 200, headers });
}
