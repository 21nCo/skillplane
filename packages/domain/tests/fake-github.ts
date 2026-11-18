import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// An in-process GitHub REST and GraphQL fake for one private repository and
// one App installation. It verifies App JWTs against the App's public key,
// issues installation tokens limited to the requested repositories and
// permission, and keeps a tiny Git object store so writes create real commits.
// Branches move only through GraphQL `updateRefs`, which applies `beforeOid`
// atomically as GitHub documents.

export const appKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
export const appPrivateKeyPem = appKeys.privateKey
  .export({ type: "pkcs1", format: "pem" })
  .toString();

interface Entry {
  mode: string;
  type: "blob";
  sha: string;
}

export interface FakeGitHub {
  readonly baseUrl: string;
  readonly installationId: number;
  readonly repository: string;
  readonly mints: { repositories: string[]; permissions: Record<string, string> }[];
  readonly tokens: Map<string, { access: string; repositories: string[] }>;
  /** Remove the installation: minting 404s and issued tokens 401. */
  revoke(): void;
  /** Hide the repository from the installation. */
  hideRepository(): void;
  head(branch?: string): string;
  /** Move a branch outside Skillplane, as a concurrent push would. */
  pushExternal(branch?: string): string;
  /** Point a branch at any commit outside Skillplane, as a force push would. */
  resetExternal(sha: string, branch?: string): void;
  /** Run once just before the next ref update is applied. */
  beforeNextRefUpdate(fn: () => void): void;
  /** Apply the next ref update but drop its response, as a lost connection would. */
  loseNextRefUpdateResponse(): void;
  /** Run once before the next repository request whose path matches. */
  beforeNextRequest(path: RegExp, fn: () => void): void;
  /** Answer the next repository or GraphQL request with a secondary rate limit. */
  throttleNext(): void;
  /** Every repository and GraphQL request as `METHOD path`. */
  readonly requests: string[];
  blob(path: string, commit?: string): string | null;
  treeOf(commit: string): string;
  close(): Promise<void>;
}

function gitSha(kind: string, bytes: Buffer) {
  return createHash("sha1")
    .update(`${kind} ${String(bytes.length)}\0`)
    .update(bytes)
    .digest("hex");
}

async function body(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return chunks.length
    ? (JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown)
    : null;
}

function verifyJwt(header: string | undefined, appId: string): boolean {
  const jwt = header?.replace(/^Bearer /u, "") ?? "";
  const [h = "", p = "", s = ""] = jwt.split(".");
  if (
    !verify(
      "RSA-SHA256",
      Buffer.from(`${h}.${p}`),
      appKeys.publicKey,
      Buffer.from(s, "base64url"),
    )
  )
    return false;
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as {
    iss: string;
    exp: number;
    iat: number;
  };
  const now = Date.now() / 1000;
  return (
    claims.iss === appId &&
    claims.iat <= now &&
    claims.exp > now &&
    claims.exp - claims.iat <= 600
  );
}

export async function startFakeGitHub(
  files: Record<string, string>,
  options: { appId?: string; installationId?: number; repository?: string } = {},
): Promise<FakeGitHub> {
  const appId = options.appId ?? "123456",
    installationId = options.installationId ?? 77,
    repository = options.repository ?? "acme/private-skills";
  const blobs = new Map<string, Buffer>(),
    trees = new Map<string, Map<string, Entry>>(),
    commits = new Map<string, { tree: string; parents: string[]; message: string }>(),
    refs = new Map<string, string>();
  const mints: FakeGitHub["mints"] = [];
  const tokens: FakeGitHub["tokens"] = new Map();
  let revoked = false,
    hidden = false,
    serial = 0,
    beforeRefUpdate: (() => void) | null = null,
    loseRefUpdate = false,
    throttle = false,
    nextRequest: { path: RegExp; fn: () => void } | null = null;
  const requests: string[] = [];
  const nodeId = "R_kgDOfake0001";

  const putTree = (entries: Map<string, Entry>) => {
    const sha = gitSha(
      "tree",
      Buffer.from(JSON.stringify([...entries].sort(([a], [b]) => (a < b ? -1 : 1)))),
    );
    trees.set(sha, entries);
    return sha;
  };
  const putCommit = (tree: string, parents: string[], message: string) => {
    const sha = gitSha(
      "commit",
      Buffer.from(JSON.stringify({ tree, parents, message })),
    );
    commits.set(sha, { tree, parents, message });
    return sha;
  };
  const initial = new Map<string, Entry>();
  for (const [path, content] of Object.entries(files)) {
    const bytes = Buffer.from(content);
    const sha = gitSha("blob", bytes);
    blobs.set(sha, bytes);
    initial.set(path, { mode: "100644", type: "blob", sha });
  }
  refs.set("main", putCommit(putTree(initial), [], "initial"));

  const ancestors = (sha: string): Set<string> => {
    const seen = new Set<string>();
    const stack = [sha];
    while (stack.length) {
      const next = stack.pop() ?? "";
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(...(commits.get(next)?.parents ?? []));
    }
    return seen;
  };

  const server: Server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://fake");
      const send = (status: number, data?: unknown, type = "application/json") => {
        response.writeHead(status, { "content-type": type });
        response.end(
          data === undefined
            ? ""
            : typeof data === "string"
              ? data
              : JSON.stringify(data),
        );
      };
      const tokenPath = `/app/installations/${String(installationId)}/access_tokens`;
      if (url.pathname.startsWith("/app/installations/")) {
        if (
          request.method !== "POST" ||
          !verifyJwt(request.headers.authorization, appId)
        )
          return send(401, { message: "A JSON web token could not be decoded" });
        const requested = (await body(request)) as {
          repositories: string[];
          permissions: Record<string, string>;
        };
        // Every authenticated mint attempt is recorded, including refused ones.
        mints.push(requested);
        if (url.pathname !== tokenPath || revoked)
          return send(404, { message: "Not Found" });
        const name = repository.split("/")[1];
        if (
          requested.repositories.some((r) => r !== name) ||
          (hidden && requested.repositories.length)
        )
          return send(422, {
            message: "There is at least one repository that does not exist",
          });
        serial += 1;
        const token = `ghs_${String(serial).padStart(36, "0")}`;
        tokens.set(token, {
          access: requested.permissions.contents ?? "",
          repositories: requested.repositories.map(
            (r) => `${repository.split("/")[0]}/${r}`,
          ),
        });
        return send(201, {
          token,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: { ...requested.permissions, metadata: "read" },
          repository_selection: "selected",
          repositories: requested.repositories.map((r) => ({
            name: r,
            full_name: `${repository.split("/")[0]}/${r}`,
          })),
        });
      }
      const prefix = `/repos/${repository}`;
      requests.push(`${request.method ?? ""} ${url.pathname}`);
      if (nextRequest?.path.test(url.pathname)) {
        const hook = nextRequest.fn;
        nextRequest = null;
        hook();
      }
      if (throttle) {
        throttle = false;
        // GitHub's secondary limits may arrive without any rate limit header.
        return send(403, {
          message:
            "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
        });
      }
      const grant = tokens.get(
        request.headers.authorization?.replace(/^Bearer /u, "") ?? "",
      );
      if (grant && revoked) return send(401, { message: "Bad credentials" });
      if (url.pathname === "/graphql" && request.method === "POST") {
        const input = (await body(request)) as {
          query: string;
          variables: {
            input: {
              repositoryId: string;
              refUpdates: {
                name: string;
                beforeOid?: string;
                afterOid: string;
                force?: boolean;
              }[];
            };
          };
        };
        const failure = (type: string, message: string) =>
          send(200, { data: { updateRefs: null }, errors: [{ type, message }] });
        if (!grant || hidden || input.variables.input.repositoryId !== nodeId)
          return failure("NOT_FOUND", "Could not resolve to a node");
        if (!/updateRefs\(/u.test(input.query))
          return failure("UNSUPPORTED", "Only updateRefs is faked");
        if (grant.access !== "write")
          return failure("FORBIDDEN", "Resource not accessible by integration");
        const run = beforeRefUpdate;
        beforeRefUpdate = null;
        run?.();
        // All updates are checked before any is applied, as GitHub does.
        const updates = input.variables.input.refUpdates.map((update) => ({
          ...update,
          branch: update.name.replace(/^refs\/heads\//u, ""),
        }));
        for (const update of updates) {
          const current = refs.get(update.branch);
          if (update.beforeOid !== undefined && current !== update.beforeOid)
            return failure(
              "STALE_DATA",
              `Expected ${update.name} to point to ${update.beforeOid}`,
            );
          if (!current || !commits.has(update.afterOid))
            return failure("UNPROCESSABLE", "Reference or object does not exist");
          if (!update.force && !ancestors(update.afterOid).has(current))
            return failure("UNPROCESSABLE", "Update is not a fast forward");
        }
        for (const update of updates) refs.set(update.branch, update.afterOid);
        if (loseRefUpdate) {
          loseRefUpdate = false;
          request.socket.destroy();
          return;
        }
        return send(200, { data: { updateRefs: { clientMutationId: null } } });
      }
      // A private repository is invisible without a token that covers it.
      if (
        !grant ||
        hidden ||
        !grant.repositories.includes(repository) ||
        !url.pathname.startsWith(prefix)
      )
        return send(404, { message: "Not Found" });
      const path = url.pathname.slice(prefix.length);
      const write = request.method !== "GET";
      if (write && grant.access !== "write")
        return send(403, { message: "Resource not accessible by integration" });
      if (path === "")
        return send(200, { full_name: repository, node_id: nodeId, private: true });
      let match: RegExpExecArray | null;
      if ((match = /^\/commits\/(.+)$/.exec(path))) {
        const ref = decodeURIComponent(match[1] ?? "");
        const sha = refs.get(ref) ?? (commits.has(ref) ? ref : undefined);
        return sha
          ? send(200, sha, "text/plain")
          : send(404, { message: "No commit found" });
      }
      if ((match = /^\/git\/commits\/([a-f0-9]{40})$/.exec(path)) && !write) {
        const commit = commits.get(match[1] ?? "");
        return commit
          ? send(200, {
              sha: match[1],
              tree: { sha: commit.tree },
              parents: commit.parents.map((sha) => ({ sha })),
            })
          : send(404, { message: "Not Found" });
      }
      if ((match = /^\/git\/trees\/([a-f0-9]{40})$/.exec(path)) && !write) {
        const tree = trees.get(match[1] ?? "");
        if (!tree) return send(404, { message: "Not Found" });
        const dirs = new Set<string>();
        for (const p of tree.keys()) {
          const parts = p.split("/");
          for (let i = 1; i < parts.length; i += 1)
            dirs.add(parts.slice(0, i).join("/"));
        }
        return send(200, {
          truncated: false,
          tree: [
            ...[...dirs].map((p) => ({
              path: p,
              mode: "040000",
              type: "tree",
              sha: "f".repeat(40),
            })),
            ...[...tree].map(([p, e]) => ({
              path: p,
              ...e,
              size: blobs.get(e.sha)?.length ?? 0,
            })),
          ],
        });
      }
      if ((match = /^\/git\/blobs\/([a-f0-9]{40})$/.exec(path)) && !write) {
        const blob = blobs.get(match[1] ?? "");
        return blob
          ? send(200, {
              sha: match[1],
              encoding: "base64",
              content: blob.toString("base64"),
            })
          : send(404, { message: "Not Found" });
      }
      if (path === "/git/blobs" && request.method === "POST") {
        const input = (await body(request)) as { content: string; encoding: string };
        const bytes = Buffer.from(input.content, "base64");
        const sha = gitSha("blob", bytes);
        blobs.set(sha, bytes);
        return send(201, { sha });
      }
      if (path === "/git/trees" && request.method === "POST") {
        const input = (await body(request)) as {
          base_tree?: string;
          tree: { path: string; mode: string; sha: string | null }[];
        };
        const base = input.base_tree
          ? trees.get(input.base_tree)
          : new Map<string, Entry>();
        if (!base) return send(422, { message: "base_tree is not a valid tree" });
        const next = new Map(base);
        for (const entry of input.tree) {
          if (entry.sha === null) next.delete(entry.path);
          else if (!blobs.has(entry.sha)) return send(422, { message: "Invalid sha" });
          else next.set(entry.path, { mode: entry.mode, type: "blob", sha: entry.sha });
        }
        return send(201, { sha: putTree(next) });
      }
      if (path === "/git/commits" && request.method === "POST") {
        const input = (await body(request)) as {
          message: string;
          tree: string;
          parents: string[];
        };
        if (!trees.has(input.tree) || input.parents.some((p) => !commits.has(p)))
          return send(422, { message: "Invalid commit" });
        const sha = putCommit(input.tree, input.parents, input.message);
        return send(201, { sha, tree: { sha: input.tree } });
      }
      if ((match = /^\/git\/ref\/heads\/(.+)$/.exec(path)) && !write) {
        const sha = refs.get(decodeURIComponent(match[1] ?? ""));
        return sha
          ? send(200, {
              ref: `refs/heads/${match[1] ?? ""}`,
              object: { sha, type: "commit" },
            })
          : send(404, { message: "Not Found" });
      }
      return send(404, { message: "Not Found" });
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${String(port)}`,
    installationId,
    repository,
    mints,
    tokens,
    revoke() {
      revoked = true;
    },
    hideRepository() {
      hidden = true;
    },
    head(branch = "main") {
      return refs.get(branch) ?? "";
    },
    pushExternal(branch = "main") {
      const parent = refs.get(branch) ?? "";
      const commit = putCommit(
        commits.get(parent)?.tree ?? "",
        [parent],
        `external ${String(++serial)}`,
      );
      refs.set(branch, commit);
      return commit;
    },
    resetExternal(sha, branch = "main") {
      refs.set(branch, sha);
    },
    beforeNextRefUpdate(fn) {
      beforeRefUpdate = fn;
    },
    loseNextRefUpdateResponse() {
      loseRefUpdate = true;
    },
    beforeNextRequest(path, fn) {
      nextRequest = { path, fn };
    },
    throttleNext() {
      throttle = true;
    },
    requests,
    blob(path, commit) {
      const tree = trees.get(commits.get(commit ?? refs.get("main") ?? "")?.tree ?? "");
      const entry = tree?.get(path);
      return entry ? (blobs.get(entry.sha)?.toString("utf8") ?? null) : null;
    },
    treeOf(commit) {
      return commits.get(commit)?.tree ?? "";
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
