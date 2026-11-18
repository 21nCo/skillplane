import { parse } from "yaml";
import {
  BundlePathError,
  BundleValidationError,
  bundlePathCollisionKey,
  canonicalizeBundleFiles,
  containsSuspectedCredential,
  GIT_IMPORT_LIMITS,
  gitSkillRoots,
  nestedGitSkillRoot,
  normalizeBundlePath,
  skillJsonSchema,
  type CanonicalBundle,
} from "@skillplane/storage";
import { DomainError } from "./errors.js";
import {
  GITHUB_API_BASE_URL,
  GITHUB_API_VERSION,
  GitHubAuthFailedError,
  isGitHubAuthFailed,
  type GitHubApp,
  type GitHubContentsAccess,
} from "./github-app.js";
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
// Reads a repository snapshot through the GitHub REST API. Subclasses decide
// how a request is sent (anonymously or with an installation token) and what
// an unknown repository or ref means for them.
abstract class GitHubSnapshotProvider implements GitSourceProvider {
  protected abstract readonly apiBaseUrl: string;
  protected abstract send(
    repository: string,
    url: string,
    init: RequestInit,
  ): Promise<Response>;
  // Called when GitHub answers 404 to any snapshot request, or 422 to
  // resolving the ref or pinned commit.
  protected abstract missing(
    repository: string,
    deadline: number,
    stage: "resolve" | "content",
  ): Promise<never>;
  async snapshot(input: GitSourceConfig, pinned?: string): Promise<GitSnapshot> {
    const config = gitSourceConfig({ ...input });
    if (pinned && !/^[a-f0-9]{40}$/i.test(pinned)) invalid("Invalid preview commit");
    const repository = repositoryName(config.repositoryUrl);
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
        response = await this.send(
          repository,
          `${this.apiBaseUrl}/repos/${repository}/${path}`,
          {
            headers: {
              accept,
              "x-github-api-version": GITHUB_API_VERSION,
              "user-agent": "Skillplane-public-source-import",
            },
            // workerd supports only "follow" and "manual"; redirects are
            // rejected below and never followed.
            redirect: "manual",
            signal: AbortSignal.timeout(Math.min(10000, remaining)),
          },
        );
      } catch (e) {
        if (e instanceof DomainError) throw e;
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
        if (response.status === 404 || (stage === "resolve" && response.status === 422))
          return this.missing(repository, deadline, stage);
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
      tree.tree.length > GIT_IMPORT_LIMITS.treeEntries
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
    // Workspace repository export checks its trees with the same discovery.
    const roots = gitSkillRoots(entries);
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
        if (nestedGitSkillRoot(root, roots) !== undefined)
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
        // Limits, outages and revoked access abort the whole snapshot rather
        // than reporting one skill as invalid.
        if (
          error instanceof SnapshotLimitError ||
          isGitHubAuthFailed(error) ||
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

function rejected(): DomainError {
  return new DomainError(
    "SERVICE_UNAVAILABLE",
    "GitHub rejected the request; check its availability or rate limit",
    503,
  );
}

function repositoryName(repositoryUrl: string): string {
  return repositoryUrl.slice("https://github.com/".length);
}

/** Reads public repositories anonymously. */
export class PublicGitHubSourceProvider extends GitHubSnapshotProvider {
  protected readonly apiBaseUrl = GITHUB_API_BASE_URL;
  // workerd rejects fetch called with a receiver other than the global scope,
  // so the default looks up and calls the global fetch on each request.
  constructor(
    private readonly fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {
    super();
  }
  protected send(_repository: string, url: string, init: RequestInit) {
    return this.fetcher(url, init);
  }
  // GitHub answers an unknown repository with 404 and an unknown branch, tag
  // or commit with 404 or 422. A missing object after resolution is an
  // incomplete snapshot.
  protected missing(
    _repository: string,
    _deadline: number,
    stage: "resolve" | "content",
  ): Promise<never> {
    if (stage === "resolve") invalid("Public repository or ref was not found");
    throw rejected();
  }
}

/** One entry of a tree written on top of a base tree; a null SHA deletes the path. */
export interface GitTreeChange {
  path: string;
  mode: "100644" | "100755";
  sha: string | null;
}

const SHA = /^[a-f0-9]{40}$/;
const MAX_WRITE_RESPONSE_BYTES = 1024 * 1024;
const MAX_COMMIT_MESSAGE_BYTES = 64 * 1024;

/** The branch no longer points at the commit the caller based its write on. */
export class GitHubRefConflictError extends DomainError {
  constructor() {
    super(
      "CONFLICT",
      "The branch moved since the expected commit; refresh and retry",
      409,
      { reason: "stale_ref" },
    );
    this.name = "GitHubRefConflictError";
  }
}

// A Git branch name as `git check-ref-format --branch` accepts it, restricted
// to printable ASCII without shell- or URL-significant characters.
function branchName(branch: string): string {
  if (
    typeof branch !== "string" ||
    branch.length === 0 ||
    branch.length > 200 ||
    !/^[A-Za-z0-9._/-]+$/.test(branch) ||
    branch.startsWith("/") ||
    branch.endsWith("/") ||
    branch.endsWith(".") ||
    branch.startsWith("-") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.split("/").some((part) => part.startsWith(".") || part.endsWith(".lock"))
  )
    invalid("Invalid branch name");
  return branch;
}

function gitSha(value: unknown, message = "GitHub returned an invalid object"): string {
  if (typeof value !== "string" || !SHA.test(value)) invalid(message);
  return value;
}

/**
 * Reads private repositories and writes contents with installation tokens of
 * the Skillplane GitHub App. Snapshots use `contents: read` tokens and the
 * write primitives `contents: write` tokens, each limited to the repository.
 */
export class AuthenticatedGitHubSourceProvider extends GitHubSnapshotProvider {
  protected readonly apiBaseUrl: string;
  constructor(
    private readonly app: GitHubApp,
    readonly installationId: number,
  ) {
    super();
    this.apiBaseUrl = app.apiBaseUrl;
  }
  protected send(repository: string, url: string, init: RequestInit) {
    return this.app.installationFetch(
      {
        installationId: this.installationId,
        repositories: [repository],
        access: "read",
      },
      url,
      init,
    );
  }
  // GitHub answers 404 both for a missing object and for a repository the
  // token no longer sees. The token was minted for this repository, so asking
  // for the repository itself tells them apart: hidden means the installation
  // lost access (auth_failed); visible returns its REST record, and the
  // caller decides what the missing object means for its operation.
  private async visibleRepository(
    repository: string,
    access: GitHubContentsAccess,
    deadline: number,
  ): Promise<Record<string, unknown>> {
    const response = await this.call(
      repository,
      access,
      "GET",
      "",
      undefined,
      deadline,
    );
    if (response.data) return response.data;
    if (response.status === 404) throw new GitHubAuthFailedError();
    throw rejected();
  }

  protected override async missing(
    repository: string,
    deadline: number,
    stage: "resolve" | "content",
  ): Promise<never> {
    await this.visibleRepository(repository, "read", deadline);
    if (stage === "resolve") invalid("Repository ref was not found");
    throw rejected();
  }

  // Sends one installation-authenticated JSON request to a path of the
  // repository, or to the GraphQL endpoint for `{ graphql: true }`. A non-2xx
  // answer other than 401/403/429 (classified by GitHubApp) is returned as its
  // status without a body.
  private async call(
    repository: string,
    access: GitHubContentsAccess,
    method: "GET" | "POST",
    path: string | { graphql: true },
    body?: unknown,
    deadline = Date.now() + 10000,
  ): Promise<{ status: number; data: Record<string, unknown> | null }> {
    const remaining = deadline - Date.now();
    if (remaining <= 0)
      throw new DomainError("SERVICE_UNAVAILABLE", "GitHub request timed out", 503);
    const response = await this.app.installationFetch(
      { installationId: this.installationId, repositories: [repository], access },
      typeof path === "object"
        ? `${this.apiBaseUrl}/graphql`
        : `${this.apiBaseUrl}/repos/${repository}${path ? `/${path}` : ""}`,
      {
        method,
        headers: {
          accept: "application/vnd.github+json",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(10000, remaining)),
      },
    );
    if (
      response.type === "opaqueredirect" ||
      (response.status >= 300 && response.status < 400)
    ) {
      await response.body?.cancel();
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "GitHub redirected a request; retry later",
        503,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, data: null };
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
        if (size > MAX_WRITE_RESPONSE_BYTES) {
          await reader.cancel();
          invalid("GitHub response exceeds the size limit");
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
      return {
        status: response.status,
        data: object(JSON.parse(new TextDecoder().decode(bytes)) as unknown),
      };
    } catch {
      invalid("GitHub returned invalid JSON");
    }
  }

  private write(
    repositoryUrl: string,
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ) {
    const repository = repositoryName(gitSourceConfig({ repositoryUrl }).repositoryUrl);
    return this.call(repository, "write", method, path, body);
  }

  // A write GitHub refused. 404 is either lost access (auth_failed) or a
  // referenced object the repository does not have; 422 an invalid object;
  // anything else a retryable outage.
  private async refused(repositoryUrl: string, status: number): Promise<never> {
    if (status === 404) {
      const repository = repositoryName(
        gitSourceConfig({ repositoryUrl }).repositoryUrl,
      );
      await this.visibleRepository(repository, "write", Date.now() + 10000);
      invalid("GitHub could not find a referenced Git object");
    }
    if (status === 422) invalid("GitHub refused the Git object");
    throw rejected();
  }

  /** Stores file content as a blob and returns its verified Git SHA. */
  async createBlob(repositoryUrl: string, content: Uint8Array): Promise<string> {
    if (content.byteLength > MAX_BLOB_BYTES) invalid("File exceeds the size limit");
    const header = new TextEncoder().encode(`blob ${String(content.byteLength)}\0`),
      encoded = new Uint8Array(header.length + content.length);
    encoded.set(header);
    encoded.set(content, header.length);
    const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-1", encoded))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    let binary = "";
    for (let i = 0; i < content.length; i += 0x8000)
      binary += String.fromCharCode(...content.subarray(i, i + 0x8000));
    const result = await this.write(repositoryUrl, "POST", "git/blobs", {
      content: btoa(binary),
      encoding: "base64",
    });
    if (!result.data) return this.refused(repositoryUrl, result.status);
    if (gitSha(result.data.sha) !== expected)
      invalid("GitHub returned a different blob");
    return expected;
  }

  /** Writes a tree of file changes on top of `baseTree` (or from empty). */
  async createTree(
    repositoryUrl: string,
    input: { baseTree: string | null; entries: readonly GitTreeChange[] },
  ): Promise<string> {
    if (input.baseTree !== null) gitSha(input.baseTree, "Invalid base tree");
    if (
      input.entries.length === 0 ||
      input.entries.length > GIT_IMPORT_LIMITS.treeEntries
    )
      invalid("A tree write needs between 1 and 10000 entries");
    const paths = new Set<string>();
    const tree = input.entries.map((entry) => {
      if (!entry.path || !safePath(entry.path) || paths.has(entry.path))
        invalid("Invalid or duplicate tree path");
      paths.add(entry.path);
      // Callers outside TypeScript can pass any mode string.
      const mode: string = entry.mode;
      if (mode !== "100644" && mode !== "100755")
        invalid("Unsupported tree entry mode");
      if (entry.sha !== null) gitSha(entry.sha, "Invalid blob identity");
      return { path: entry.path, mode: entry.mode, type: "blob", sha: entry.sha };
    });
    const result = await this.write(repositoryUrl, "POST", "git/trees", {
      ...(input.baseTree === null ? {} : { base_tree: input.baseTree }),
      tree,
    });
    if (!result.data) return this.refused(repositoryUrl, result.status);
    return gitSha(result.data.sha);
  }

  /** Creates a commit of `tree` with the given parents, authored by the App. */
  async createCommit(
    repositoryUrl: string,
    input: { message: string; tree: string; parents: readonly string[] },
  ): Promise<string> {
    if (
      typeof input.message !== "string" ||
      !input.message.trim() ||
      input.message.includes("\0") ||
      new TextEncoder().encode(input.message).byteLength > MAX_COMMIT_MESSAGE_BYTES
    )
      invalid("Invalid commit message");
    gitSha(input.tree, "Invalid tree identity");
    if (input.parents.length > 1) invalid("A sync commit has at most one parent");
    for (const parent of input.parents) gitSha(parent, "Invalid parent commit");
    const result = await this.write(repositoryUrl, "POST", "git/commits", {
      message: input.message,
      tree: input.tree,
      parents: input.parents,
    });
    if (!result.data) return this.refused(repositoryUrl, result.status);
    const commit = gitSha(result.data.sha);
    if (text(object(result.data.tree).sha) !== input.tree)
      invalid("GitHub returned a different commit tree");
    return commit;
  }

  /**
   * Moves `branch` to `commitSha` only while it points at `expectedSha`.
   * GitHub's GraphQL `updateRefs` applies the move atomically with
   * `beforeOid`, so a concurrent move of any kind, including a reset to an
   * older commit, is refused instead of overwritten.
   *
   * Outcomes, by where they arise:
   * - DomainError VALIDATION_FAILED 400 for an invalid `branch`, `commitSha`,
   *   `expectedSha` or `repositoryUrl` (before any request), or for a
   *   malformed GitHub answer to a read before the mutation or after a
   *   refused or unconfirmed answer (a branch SHA that is not a commit SHA, a
   *   repository without `node_id`, an empty body, invalid JSON or an
   *   oversized body). A malformed mutation response follows the
   *   lost-or-failed rule below, and a malformed recovery read keeps the
   *   mutation error.
   * - Before the mutation, the branch is read: already at `commitSha` is
   *   success with no mutation (an idempotent retry); missing or at any
   *   commit other than `expectedSha` is GitHubRefConflictError (CONFLICT
   *   409, reason `stale_ref`); the caller refreshes and retries.
   * - The mutation applies (a 2xx answer with no GraphQL errors and a
   *   non-null `data.updateRefs` object): success, with no re-read.
   * - GitHub answers the mutation with GraphQL errors (refused): the branch
   *   is read again. At `commitSha` is success; missing or at a third commit
   *   is `stale_ref`; still at `expectedSha` is SERVICE_UNAVAILABLE 503 for a
   *   `RATE_LIMITED` error (retry later), otherwise DomainError CONFLICT 409
   *   with reason `update_rejected` (for example a protected branch;
   *   refreshing does not help).
   * - GitHub answers 2xx with no GraphQL errors but without a
   *   `data.updateRefs` object (unconfirmed): the branch is read again. At
   *   `commitSha` is success; missing or at a third commit is `stale_ref`;
   *   still at `expectedSha` is SERVICE_UNAVAILABLE 503 (retry later).
   * - The mutation response is lost or fails (a transport error, timeout,
   *   non-2xx status, or a malformed body: an empty body, invalid JSON, an
   *   oversized body or a non-object GraphQL `errors` entry): the branch is
   *   read again. At `commitSha` is success (the update landed); a re-read
   *   that confirms lost access (a revoked installation or a hidden
   *   repository) is GitHubAuthFailedError; anything else, including a
   *   missing branch, a third commit or a re-read that fails for another
   *   reason (a malformed re-read included), rethrows the original error:
   *   usually a retryable SERVICE_UNAVAILABLE 503, or VALIDATION_FAILED 400
   *   for a malformed mutation response. A retry then reports `stale_ref`
   *   from its first read if the branch moved. An auth failure of the
   *   mutation itself (or an unexpected non-domain error) is rethrown
   *   without a re-read.
   * - Any other failure of a read before the mutation or after a refusal or
   *   an unconfirmed answer, including minting its token, is
   *   SERVICE_UNAVAILABLE 503 (rate limit,
   *   outage, timeout, redirect or rejected request; retry later) or
   *   GitHubAuthFailedError (GIT_SOURCE_AUTH_FAILED) when the installation
   *   is revoked or the repository is no longer visible to it.
   */
  async updateRef(
    repositoryUrl: string,
    input: { branch: string; commitSha: string; expectedSha: string },
  ): Promise<void> {
    const branch = branchName(input.branch);
    const commit = gitSha(input.commitSha, "Invalid commit"),
      expected = gitSha(input.expectedSha, "Invalid expected commit");
    const repository = repositoryName(gitSourceConfig({ repositoryUrl }).repositoryUrl);
    const refPath = `git/ref/heads/${branch
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/")}`;
    // The branch's commit, or null when the visible repository has no such
    // branch; a hidden repository is auth_failed.
    const current = async (): Promise<string | null> => {
      const read = await this.call(repository, "write", "GET", refPath);
      if (read.data) return gitSha(object(read.data.object).sha);
      if (read.status !== 404) throw rejected();
      await this.visibleRepository(repository, "write", Date.now() + 10000);
      return null;
    };
    const before = await current();
    if (before === commit) return;
    if (before !== expected) throw new GitHubRefConflictError();
    const repositoryId = text(
      (await this.visibleRepository(repository, "write", Date.now() + 10000)).node_id,
    );
    if (!repositoryId) invalid("GitHub returned an invalid repository");
    let outcome: "applied" | "refused" | "rate_limited" | "unconfirmed";
    try {
      const result = await this.call(
        repository,
        "write",
        "POST",
        { graphql: true },
        {
          query:
            "mutation($input: UpdateRefsInput!) { updateRefs(input: $input) { clientMutationId } }",
          variables: {
            input: {
              repositoryId,
              refUpdates: [
                {
                  name: `refs/heads/${branch}`,
                  beforeOid: expected,
                  afterOid: commit,
                  force: false,
                },
              ],
            },
          },
        },
      );
      if (!result.data) throw rejected();
      const errors = Array.isArray(result.data.errors) ? result.data.errors : [];
      const data = result.data.data;
      const payload =
        data && typeof data === "object" && !Array.isArray(data)
          ? (data as Record<string, unknown>).updateRefs
          : null;
      // Only an error-free answer carrying the mutation's result confirms the
      // move; any other 200 envelope is reconciled by reading the branch.
      outcome =
        errors.length > 0
          ? errors.some((error) => object(error).type === "RATE_LIMITED")
            ? "rate_limited"
            : "refused"
          : payload && typeof payload === "object" && !Array.isArray(payload)
            ? "applied"
            : "unconfirmed";
    } catch (error) {
      // A lost or failed response may hide an applied update: the branch at
      // the new commit is success. A re-read that confirms lost access is
      // auth_failed; anything else keeps the original error.
      if (isGitHubAuthFailed(error) || !(error instanceof DomainError)) throw error;
      const landed = await current().catch((readError: unknown) => {
        if (isGitHubAuthFailed(readError)) throw readError;
        return null;
      });
      if (landed === commit) return;
      throw error;
    }
    if (outcome === "applied") return;
    // GitHub refused or did not confirm the update: decide by where the
    // branch is now.
    const after = await current();
    if (after === commit) return;
    if (after !== expected) throw new GitHubRefConflictError();
    if (outcome === "rate_limited")
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "GitHub rate limit reached; retry later",
        503,
      );
    if (outcome === "unconfirmed")
      throw new DomainError(
        "SERVICE_UNAVAILABLE",
        "GitHub did not confirm the branch update; retry later",
        503,
      );
    // Still at the expected commit: a protected branch or a non-fast-forward.
    throw new DomainError("CONFLICT", "GitHub refused the branch update", 409, {
      reason: "update_rejected",
    });
  }
}

/**
 * The provider for a source: an installation-authenticated one when the source
 * has a GitHub App installation, otherwise anonymous public access.
 */
export function selectGitSourceProvider(
  source: { installationId: number | null },
  options: { app: GitHubApp | null; fetcher?: typeof fetch },
): GitSourceProvider {
  if (source.installationId === null)
    return new PublicGitHubSourceProvider(options.fetcher);
  if (!options.app)
    throw new DomainError(
      "SERVICE_UNAVAILABLE",
      "The GitHub App is not configured for this deployment",
      503,
    );
  return new AuthenticatedGitHubSourceProvider(options.app, source.installationId);
}
