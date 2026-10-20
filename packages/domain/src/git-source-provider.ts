import { parse } from "yaml";
import {
  BundlePathError,
  BundleValidationError,
  bundlePathCollisionKey,
  canonicalizeBundleFiles,
  containsSuspectedCredential,
  GIT_IMPORT_LIMITS,
  normalizeBundlePath,
  skillJsonSchema,
  type CanonicalBundle,
} from "@skillplane/storage";
import { DomainError } from "./errors.js";
export interface GitSourceConfig {
  repositoryUrl: string;
  ref: string;
  refPolicy: "track" | "pin";
  path: string | null;
}
export interface GitDiscoveredSkill {
  path: string;
  bundle: CanonicalBundle | null;
  error: string | null;
}
export interface GitSnapshot {
  commitSha: string;
  skills: GitDiscoveredSkill[];
}
export interface GitSourceProvider {
  snapshot(config: GitSourceConfig, commitSha?: string): Promise<GitSnapshot>;
}
class SnapshotLimitError extends DomainError {
  constructor(message: string) {
    super("VALIDATION_FAILED", message, 400);
  }
}
function invalid(message: string): never {
  throw new DomainError("VALIDATION_FAILED", message, 400);
}
export function gitSourceConfig(input: Record<string, unknown>): GitSourceConfig {
  if (typeof input.repositoryUrl !== "string")
    invalid("A public GitHub repository URL is required");
  let url: URL;
  try {
    url = new URL(input.repositoryUrl);
  } catch {
    invalid("Invalid repository URL");
  }
  const match =
    /^\/([A-Za-z0-9][A-Za-z0-9-]{0,38})\/([A-Za-z0-9_.-]{1,100}?)(?:\.git)?\/?$/.exec(
      url.pathname,
    );
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !match ||
    match[2] === "." ||
    match[2] === ".."
  )
    invalid("Use an HTTPS github.com owner/repository URL");
  const ref = input.ref ?? "HEAD",
    refPolicy = input.refPolicy ?? "track",
    path = input.path ?? null;
  if (
    typeof ref !== "string" ||
    !ref ||
    ref.length > 200 ||
    // eslint-disable-next-line no-control-regex -- reject control characters in untrusted refs
    /[\x00-\x20\\?#]/u.test(ref)
  )
    invalid("A valid branch, tag, or commit is required");
  if (refPolicy !== "pin" && refPolicy !== "track")
    invalid("Ref policy must be track or pin");
  if (refPolicy === "pin" && !/^[a-f0-9]{40}$/i.test(ref))
    invalid("Pinned sources require a full commit SHA");
  if (path !== null && (typeof path !== "string" || !safePath(path)))
    invalid("Use a safe repository-relative SKILL.md path or skill directory");
  return {
    repositoryUrl: `https://github.com/${match[1] ?? ""}/${match[2] ?? ""}`,
    ref,
    refPolicy,
    path:
      path === "SKILL.md"
        ? ""
        : typeof path === "string" && path.endsWith("/SKILL.md")
          ? path.slice(0, -"/SKILL.md".length)
          : path,
  };
}
// Repository paths locate a skill directory; files inside it are validated
// separately with the canonical bundle-relative path rules.
function safePath(path: string) {
  return (
    path === "" ||
    (path.length <= 1024 &&
      // eslint-disable-next-line no-control-regex -- reject control characters in untrusted paths
      !/[\\\x00-\x1f]/u.test(path) &&
      !path.startsWith("/") &&
      !/^[A-Za-z]:/.test(path) &&
      path.split("/").every((s) => s && s !== "." && s !== ".." && s !== "~"))
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    invalid("GitHub returned invalid data");
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") invalid("GitHub returned invalid data");
  return value;
}
interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  sha: string;
  size: number;
}
// Workspace repository export checks the same per-skill limits.
const MAX_SNAPSHOT_BYTES = GIT_IMPORT_LIMITS.snapshotBytes,
  MAX_BLOB_BYTES = GIT_IMPORT_LIMITS.blobBytes,
  MAX_REQUESTS = GIT_IMPORT_LIMITS.requests,
  // Ref, commit and tree requests leave this many distinct blob fetches for one skill.
  MAX_SKILL_FILES = GIT_IMPORT_LIMITS.skillFiles;
export class PublicGitHubSourceProvider implements GitSourceProvider {
  // workerd rejects fetch called with a receiver other than the global scope,
  // so the default looks up and calls the global fetch on each request.
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}
  async snapshot(input: GitSourceConfig, pinned?: string): Promise<GitSnapshot> {
    const config = gitSourceConfig({ ...input });
    if (pinned && !/^[a-f0-9]{40}$/i.test(pinned)) invalid("Invalid preview commit");
    const repository = config.repositoryUrl.slice("https://github.com/".length);
    let requests = 0,
      totalBytes = 0;
    const deadline = Date.now() + 90000;
    // Resolving the configured ref or pinned commit can fail permanently when
    // the repository or ref does not exist. A failed tree or blob request after
    // resolution is an incomplete snapshot and aborts the whole import.
    const fetchBytes = async (
      path: string,
      maxBytes: number,
      stage: "resolve" | "content",
      accept = "application/vnd.github+json",
    ) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0)
        throw new DomainError("SERVICE_UNAVAILABLE", "Git source fetch timed out", 503);
      if (++requests > MAX_REQUESTS)
        throw new SnapshotLimitError(
          "Source exceeds the 200 request import limit; reduce its skill/file scope",
        );
      let response: Response;
      try {
        response = await this.fetcher(
          `https://api.github.com/repos/${repository}/${path}`,
          {
            headers: {
              accept,
              "x-github-api-version": "2026-03-10",
              "user-agent": "Skillplane-public-source-import",
            },
            // workerd supports only "follow" and "manual"; redirects are
            // rejected below and never followed.
            redirect: "manual",
            signal: AbortSignal.timeout(Math.min(10000, remaining)),
          },
        );
      } catch {
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          "GitHub could not be reached; retry later",
          503,
        );
      }
      if (
        response.type === "opaqueredirect" ||
        (response.status >= 300 && response.status < 400)
      ) {
        await response.body?.cancel();
        // A moved or renamed repository redirects its ref resolution.
        if (stage === "resolve")
          invalid("GitHub redirected the repository; use its current URL");
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          "GitHub redirected a content request; retry later",
          503,
        );
      }
      if (!response.ok) {
        await response.body?.cancel();
        // GitHub answers an unknown repository with 404 and an unknown
        // branch, tag or commit with 404 or 422.
        if (stage === "resolve" && (response.status === 404 || response.status === 422))
          invalid("Public repository or ref was not found");
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          "GitHub rejected the request; check its availability or rate limit",
          503,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) invalid("GitHub returned an empty response");
      const parts: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const next = await reader.read();
          if (next.done) break;
          size += next.value.byteLength;
          if (size > maxBytes) {
            await reader.cancel();
            invalid("GitHub response exceeds the import limit");
          }
          parts.push(next.value);
        }
      } catch (e) {
        if (e instanceof DomainError) throw e;
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          "GitHub response was interrupted; retry later",
          503,
        );
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      return new TextDecoder().decode(bytes);
    };
    const read = async (
      path: string,
      maxBytes: number,
      stage: "resolve" | "content",
    ) => {
      const body = await fetchBytes(path, maxBytes, stage);
      try {
        return object(JSON.parse(body) as unknown);
      } catch {
        invalid("GitHub returned invalid JSON");
      }
    };
    // Resolve a ref with the SHA media type: the full commit resource embeds
    // per-file patches whose size is unrelated to the skills being imported.
    const sha = pinned
      ? pinned.toLowerCase()
      : (
          await fetchBytes(
            `commits/${encodeURIComponent(config.ref)}`,
            1024,
            "resolve",
            "application/vnd.github.sha",
          )
        ).trim();
    if (!/^[a-f0-9]{40}$/.test(sha)) invalid("GitHub returned an invalid commit");
    const commit = await read(
      `git/commits/${sha}`,
      256 * 1024,
      pinned ? "resolve" : "content",
    );
    if (commit.sha !== sha) invalid("GitHub returned a different commit");
    const treeSha = text(object(commit.tree).sha);
    if (!/^[a-f0-9]{40}$/.test(treeSha)) invalid("Invalid Git tree identity");
    const tree = await read(
      `git/trees/${treeSha}?recursive=1`,
      8 * 1024 * 1024,
      "content",
    );
    if (
      tree.truncated !== false ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > 10000
    )
      invalid(
        "Repository tree is incomplete or too large; import a smaller repository",
      );
    // Out-of-scope entries are never fetched, so only in-scope paths are
    // validated, and an unsafe in-scope path is reported as that skill's error.
    const entries: TreeEntry[] = tree.tree.map((value: unknown) => {
      const row = object(value);
      const path = text(row.path);
      if (!path) invalid("GitHub returned invalid data");
      return {
        path,
        mode: text(row.mode),
        type: text(row.type),
        sha: text(row.sha),
        size: typeof row.size === "number" ? row.size : 0,
      };
    });
    if (new Set(entries.map((e) => e.path)).size !== entries.length)
      invalid("Repository tree contains duplicate paths");
    const roots = entries
      .filter((e) => e.path === "SKILL.md" || e.path.endsWith("/SKILL.md"))
      .map((e) => e.path.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
    const selected =
      config.path === null ? roots : roots.filter((root) => root === config.path);
    if (selected.length > GIT_IMPORT_LIMITS.skills)
      invalid("Import at most 32 skills per source; choose a specific path");
    const blobCache = new Map<string, Uint8Array>();
    const skills: GitDiscoveredSkill[] = [];
    if (config.path !== null && selected.length === 0)
      skills.push({
        path: config.path,
        bundle: null,
        error: "No SKILL.md exists at the configured path",
      });
    for (const root of selected.sort()) {
      try {
        if (!safePath(root)) invalid("Skill directory path is unsafe or too long");
        if (
          roots.some(
            (other) => other !== root && (root === "" || other.startsWith(`${root}/`)),
          )
        )
          invalid("Nested skill roots require separate single-path sources");
        const prefix = root ? `${root}/` : "";
        const files = new Map<string, Uint8Array>();
        const local = entries.filter(
          (e) => e.path.startsWith(prefix) && e.type !== "tree",
        );
        if (new Set(local.map((e) => e.sha)).size > MAX_SKILL_FILES)
          invalid(
            `Skill exceeds the ${String(MAX_SKILL_FILES)} distinct blob import limit; reduce its files`,
          );
        // A skill directory is imported as one complete bundle. Unsupported files,
        // links and paths are errors, rather than silently dropping source content,
        // and every entry is checked before any of the skill's blobs is fetched.
        const paths = new Map<TreeEntry, string>(),
          collisions = new Set<string>();
        for (const entry of local) {
          if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
            invalid("Skill contains a symlink, submodule, or unsupported file mode");
          const relative = entry.path.slice(prefix.length);
          let path: string;
          try {
            path = normalizeBundlePath(relative);
          } catch (e) {
            if (!(e instanceof BundlePathError)) throw e;
            invalid(
              `Skill file ${JSON.stringify(relative.slice(0, 200))}: ${e.message}`,
            );
          }
          // NFC/NFD or case-only twins would otherwise overwrite one another.
          const key = bundlePathCollisionKey(path);
          if (collisions.has(key))
            invalid("Skill contains paths that collide after Unicode or case folding");
          collisions.add(key);
          if (
            !/^[a-f0-9]{40}$/.test(entry.sha) ||
            entry.size > MAX_BLOB_BYTES ||
            entry.size < 0
          )
            invalid("Skill file exceeds the size limit");
          paths.set(entry, path);
        }
        for (const entry of local) {
          const path = paths.get(entry) ?? invalid("Skill path was not validated");
          if (totalBytes + entry.size > MAX_SNAPSHOT_BYTES)
            throw new SnapshotLimitError(
              "Source exceeds the 20 MiB expanded import limit",
            );
          let bytes = blobCache.get(entry.sha);
          if (!bytes) {
            const blob = await read(
              `git/blobs/${entry.sha}`,
              Math.ceil(MAX_BLOB_BYTES * 1.5) + 4096,
              "content",
            );
            if (blob.sha !== entry.sha || blob.encoding !== "base64")
              invalid("GitHub returned a different blob");
            const content = text(blob.content).replace(/\s/g, "");
            if (!/^[A-Za-z0-9+/]*={0,2}$/.test(content))
              invalid("Invalid blob encoding");
            bytes = Uint8Array.from(atob(content), (c) => c.charCodeAt(0));
            if (bytes.length !== entry.size || bytes.length > MAX_BLOB_BYTES)
              invalid("Blob size mismatch");
            const header = new TextEncoder().encode(`blob ${String(bytes.length)}\0`),
              encoded = new Uint8Array(header.length + bytes.length);
            encoded.set(header);
            encoded.set(bytes, header.length);
            const digest = [
              ...new Uint8Array(await crypto.subtle.digest("SHA-1", encoded)),
            ]
              .map((b) => b.toString(16).padStart(2, "0"))
              .join("");
            if (digest !== entry.sha) invalid("Blob identity mismatch");
            blobCache.set(entry.sha, bytes);
          }
          totalBytes += bytes.length;
          if (totalBytes > MAX_SNAPSHOT_BYTES)
            throw new SnapshotLimitError(
              "Source exceeds the 20 MiB expanded import limit",
            );
          if (containsSuspectedCredential(bytes))
            invalid("Skill contains a suspected credential; remove it before import");
          files.set(path, bytes);
        }
        const markdown = files.get("SKILL.md");
        if (!markdown) invalid("SKILL.md is required");
        let metadata: unknown;
        const json = files.get("skill.json");
        if (json)
          metadata = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(json),
          ) as unknown;
        else {
          const content = new TextDecoder("utf-8", { fatal: true }).decode(markdown);
          const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
          if (!match || (match[1]?.length ?? 0) > 16384)
            invalid(
              "SKILL.md needs name and description in YAML frontmatter, or skill.json",
            );
          const front = object(
            parse(match[1] ?? "", {
              maxAliasCount: 0,
              uniqueKeys: true,
              logLevel: "error",
            }) as unknown,
          );
          const name = text(front.name),
            description = text(front.description);
          const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-|-$/g, "");
          metadata = {
            formatVersion: 1,
            name,
            slug,
            description,
            tags: [],
            entrypoint: "SKILL.md",
            files: [
              {
                path: "SKILL.md",
                sha256: "0".repeat(64),
                byteSize: markdown.length,
                mediaType: "text/markdown",
              },
            ],
          };
        }
        const result = skillJsonSchema.safeParse(metadata);
        if (!result.success) invalid("Skill metadata is invalid");
        const bundle = await canonicalizeBundleFiles({ skill: result.data, files });
        skills.push({ path: root, bundle, error: null });
      } catch (error) {
        if (
          error instanceof SnapshotLimitError ||
          (error instanceof DomainError && error.status === 503)
        )
          throw error;
        skills.push({
          path: root,
          bundle: null,
          error:
            error instanceof DomainError || error instanceof BundleValidationError
              ? error.message
              : "Skill bundle is invalid or unsupported",
        });
      }
    }
    return { commitSha: sha, skills };
  }
}
