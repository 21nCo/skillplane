import { parse } from "yaml";
import {
  canonicalizeBundleFiles,
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
function safePath(path: string) {
  return (
    path === "" ||
    (path.length <= 240 &&
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
const MAX_SNAPSHOT_BYTES = 20 * 1024 * 1024,
  MAX_BLOB_BYTES = 5 * 1024 * 1024,
  MAX_REQUESTS = 200;
export class PublicGitHubSourceProvider implements GitSourceProvider {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch) {}
  async snapshot(input: GitSourceConfig, pinned?: string): Promise<GitSnapshot> {
    const config = gitSourceConfig({ ...input });
    if (pinned && !/^[a-f0-9]{40}$/i.test(pinned)) invalid("Invalid preview commit");
    const repository = config.repositoryUrl.slice("https://github.com/".length);
    let requests = 0,
      totalBytes = 0;
    const deadline = Date.now() + 90000;
    const read = async (path: string, maxBytes: number) => {
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
              accept: "application/vnd.github+json",
              "x-github-api-version": "2026-03-10",
              "user-agent": "Skillplane-public-source-import",
            },
            redirect: "error",
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
      if (!response.ok) {
        await response.body?.cancel();
        throw new DomainError(
          "SERVICE_UNAVAILABLE",
          response.status === 404
            ? "Public repository or ref was not found"
            : "GitHub rejected the request; check its availability or rate limit",
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
      try {
        return object(JSON.parse(new TextDecoder().decode(bytes)) as unknown);
      } catch {
        invalid("GitHub returned invalid JSON");
      }
    };
    const commit = await read(
      `commits/${encodeURIComponent(pinned ?? config.ref)}`,
      1024 * 1024,
    );
    const sha = text(commit.sha);
    if (!/^[a-f0-9]{40}$/.test(sha) || (pinned && sha !== pinned.toLowerCase()))
      invalid("GitHub returned a different commit");
    const treeSha = text(object(object(commit.commit).tree).sha);
    if (!/^[a-f0-9]{40}$/.test(treeSha)) invalid("Invalid Git tree identity");
    const tree = await read(`git/trees/${treeSha}?recursive=1`, 8 * 1024 * 1024);
    if (
      tree.truncated !== false ||
      !Array.isArray(tree.tree) ||
      tree.tree.length > 10000
    )
      invalid(
        "Repository tree is incomplete or too large; import a smaller repository",
      );
    const entries: TreeEntry[] = tree.tree.map((value: unknown) => {
      const row = object(value);
      const path = text(row.path);
      if (!safePath(path)) invalid("Repository contains an unsafe path");
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
    if (selected.length > 32)
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
        if (local.length > 999) invalid("Skill exceeds the file count limit");
        // A skill directory is imported as one complete bundle. Unsupported files
        // and links are errors, rather than silently dropping source content.
        for (const entry of local) {
          if (entry.type !== "blob" || !["100644", "100755"].includes(entry.mode))
            invalid("Skill contains a symlink, submodule, or unsupported file mode");
          const path = normalizeBundlePath(entry.path.slice(prefix.length));
          if (
            !/^[a-f0-9]{40}$/.test(entry.sha) ||
            entry.size > MAX_BLOB_BYTES ||
            entry.size < 0
          )
            invalid("Skill file exceeds the size limit");
          if (totalBytes + entry.size > MAX_SNAPSHOT_BYTES)
            throw new SnapshotLimitError(
              "Source exceeds the 20 MiB expanded import limit",
            );
          let bytes = blobCache.get(entry.sha);
          if (!bytes) {
            const blob = await read(
              `git/blobs/${entry.sha}`,
              Math.ceil(MAX_BLOB_BYTES * 1.5) + 4096,
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
          const decoded = new TextDecoder().decode(bytes);
          if (
            /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16})\b/.test(
              decoded,
            )
          )
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
              logLevel: "silent",
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
            error instanceof DomainError
              ? error.message
              : "Skill bundle is invalid or unsupported",
        });
      }
    }
    return { commitSha: sha, skills };
  }
}
