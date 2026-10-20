import { bytewisePathCompare } from "./paths.js";
import { sha256Hex } from "./validate.js";

/**
 * Limits of a Git source import. The source provider enforces them while it
 * reads a repository, and workspace repository export checks the per-skill
 * ones so it never writes a skill directory the importer would reject.
 */
export const GIT_IMPORT_LIMITS = {
  /** GitHub API requests per snapshot, including ref, commit and tree reads. */
  requests: 200,
  /** Distinct file contents (Git blobs) in one skill directory: the request limit less the ref, commit and tree reads. */
  skillFiles: 197,
  /** Skill directories per source. */
  skills: 32,
  blobBytes: 5 * 1024 * 1024,
  /** Expanded bytes of every imported file in a snapshot. */
  snapshotBytes: 20 * 1024 * 1024,
} as const;

const SUSPECTED_CREDENTIAL =
  /-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----|\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,}|AKIA[0-9A-Z]{16})\b/;

/** Whether file content looks like a private key or GitHub or AWS credential. */
export function containsSuspectedCredential(bytes: Uint8Array): boolean {
  return SUSPECTED_CREDENTIAL.test(new TextDecoder().decode(bytes));
}

/** An entry of a recursive Git tree listing, as GitHub's trees API reports it. */
export interface GitTreeEntryPath {
  readonly path: string;
  readonly type: string;
}

/**
 * The entries Git records for a tree of files: one blob per file and one tree
 * per ancestor directory, in bytewise path order.
 */
export function gitTreeEntries(filePaths: Iterable<string>): GitTreeEntryPath[] {
  const entries = new Map<string, string>();
  for (const path of filePaths) {
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end += 1)
      entries.set(segments.slice(0, end).join("/"), "tree");
    entries.set(path, "blob");
  }
  return [...entries]
    .map(([path, type]) => ({ path, type }))
    .sort((left, right) => bytewisePathCompare(left.path, right.path));
}

/**
 * The skill directories a Git source import discovers in a repository tree, in
 * tree order: the parent of every entry named SKILL.md, whether a file or a
 * directory, with the repository root as "".
 */
export function gitSkillRoots(entries: Iterable<GitTreeEntryPath>): string[] {
  const roots: string[] = [];
  for (const { path } of entries)
    if (path === "SKILL.md" || path.endsWith("/SKILL.md"))
      roots.push(path.slice(0, -"SKILL.md".length).replace(/\/$/, ""));
  return roots;
}

/**
 * Another discovered root inside this one, if any. The importer rejects a
 * skill directory that contains a nested root rather than splitting it.
 */
export function nestedGitSkillRoot(
  root: string,
  roots: readonly string[],
): string | undefined {
  return roots.find(
    (other) => other !== root && (root === "" || other.startsWith(`${root}/`)),
  );
}

/**
 * The first reason a Git source import would reject a skill directory holding
 * these bundle-relative files on its own, or null when it can be imported.
 * Root discovery is checked separately over the whole tree.
 */
export async function gitImportSkillProblem(
  files: ReadonlyMap<string, Uint8Array>,
): Promise<string | null> {
  const contents = new Set<string>();
  let bytes = 0;
  for (const [path, content] of files) {
    if (content.byteLength > GIT_IMPORT_LIMITS.blobBytes)
      return `${path} exceeds the ${String(GIT_IMPORT_LIMITS.blobBytes)} byte file limit`;
    if (containsSuspectedCredential(content))
      return `${path} contains a suspected credential`;
    bytes += content.byteLength;
    contents.add(await sha256Hex(content));
  }
  if (contents.size > GIT_IMPORT_LIMITS.skillFiles)
    return `it has more than ${String(GIT_IMPORT_LIMITS.skillFiles)} distinct files`;
  if (bytes > GIT_IMPORT_LIMITS.snapshotBytes)
    return `its files exceed the ${String(GIT_IMPORT_LIMITS.snapshotBytes)} byte import limit`;
  return null;
}
