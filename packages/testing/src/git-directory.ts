import { execFileSync } from "node:child_process";
import { devNull } from "node:os";

/**
 * Git runs without the caller's repository or the user's and system
 * configuration, so tests see the same behavior on every machine, with a fixed
 * identity and commit time. Every inherited `GIT_*` variable is dropped: a Git
 * hook runs with `GIT_DIR`, `GIT_INDEX_FILE` and `GIT_WORK_TREE` set, and these
 * take precedence over `-C`, so they would point the commands at the caller's
 * repository and index instead of the test's directory.
 */
function environment(globalConfig: string): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
    ),
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Skillplane Test",
    GIT_AUTHOR_EMAIL: "test@skillplane.invalid",
    GIT_AUTHOR_DATE: "2024-01-01T00:00:00Z",
    GIT_COMMITTER_NAME: "Skillplane Test",
    GIT_COMMITTER_EMAIL: "test@skillplane.invalid",
    GIT_COMMITTER_DATE: "2024-01-01T00:00:00Z",
  };
}

function git(
  repository: string,
  args: string[],
  { input, globalConfig = devNull }: { input?: string; globalConfig?: string } = {},
): Buffer {
  return execFileSync("git", ["-C", repository, ...args], {
    env: environment(globalConfig),
    ...(input === undefined ? {} : { input }),
    maxBuffer: 256 * 1024 * 1024,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

/**
 * Commits everything in a directory with `git init`, `git add -A` and
 * `git commit`, as a user publishing an export would. `core.autocrlf=true`
 * stands in for the most invasive common configuration: without attributes
 * that forbid it, Git stores CRLF text with LF line endings. `globalConfig`
 * names a file to use as the user's global Git configuration.
 */
export function commitDirectory(
  directory: string,
  { globalConfig }: { globalConfig?: string } = {},
): void {
  const crlf = ["-c", "core.autocrlf=true", "-c", "core.safecrlf=false"];
  const options = globalConfig === undefined ? {} : { globalConfig };
  git(directory, ["init", "-q"], options);
  git(directory, [...crlf, "add", "-A"], options);
  git(directory, [...crlf, "commit", "-q", "--allow-empty", "-m", "Export"], options);
}

interface TreeEntry {
  readonly path: string;
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size?: number;
}

/**
 * Serves a local repository's HEAD commit through the GitHub REST endpoints the
 * public Git source provider reads (ref, commit, recursive tree and blobs), so
 * a test imports exactly what Git committed with the production discovery and
 * validation rules.
 */
export function gitRepositoryGitHubFetcher(repository: string): typeof fetch {
  const commitSha = git(repository, ["rev-parse", "HEAD"]).toString().trim();
  const treeSha = git(repository, ["rev-parse", "HEAD^{tree}"]).toString().trim();
  const tree: TreeEntry[] = git(repository, ["ls-tree", "-r", "-t", "-l", "-z", "HEAD"])
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", type = "", sha = "", size = "-"] = line
        .slice(0, tab)
        .split(/ +/u);
      return {
        path: line.slice(tab + 1),
        mode,
        type,
        sha,
        ...(type === "blob" ? { size: Number(size) } : {}),
      };
    });
  // Reads every committed blob in one `git cat-file --batch` call; each record
  // is "<sha> blob <size>\n<content>\n".
  const shas = [...new Set(tree.filter((e) => e.type === "blob").map((e) => e.sha))];
  const batch = shas.length
    ? git(repository, ["cat-file", "--batch"], { input: `${shas.join("\n")}\n` })
    : Buffer.alloc(0);
  const blobs = new Map<string, Buffer>();
  for (let offset = 0; offset < batch.length;) {
    const header = batch.indexOf(0x0a, offset);
    const [sha = "", , size = "0"] = batch
      .subarray(offset, header)
      .toString()
      .split(" ");
    const start = header + 1;
    blobs.set(sha, batch.subarray(start, start + Number(size)));
    offset = start + Number(size) + 1;
  }
  const json = (value: unknown) => new Response(JSON.stringify(value));
  return (input) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const route = url.pathname.split("/").slice(4).join("/");
    if (route.startsWith("commits/")) return Promise.resolve(new Response(commitSha));
    if (route === `git/commits/${commitSha}`)
      return Promise.resolve(json({ sha: commitSha, tree: { sha: treeSha } }));
    if (route === `git/trees/${treeSha}`)
      return Promise.resolve(json({ sha: treeSha, truncated: false, tree }));
    const sha = route.startsWith("git/blobs/") ? route.slice("git/blobs/".length) : "";
    const blob = blobs.get(sha);
    if (blob)
      return Promise.resolve(
        json({ sha, encoding: "base64", content: blob.toString("base64") }),
      );
    return Promise.resolve(new Response("{}", { status: 404 }));
  };
}
