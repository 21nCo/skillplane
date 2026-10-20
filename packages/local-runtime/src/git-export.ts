import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  gitControlPathProblem,
  serializeWorkspaceRepository,
  unrepresentableTreeProblem,
  WORKSPACE_GITATTRIBUTES_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_SKILLS_DIRECTORY,
  WorkspaceRepositoryError,
  type WorkspaceRepositorySkill,
} from "@skillplane/storage";
import {
  RuntimeError,
  type PublishedSkill,
  type WorkspaceProvider,
} from "./contracts.js";

const listingKey = (skills: readonly PublishedSkill[]) =>
  skills
    .map((s) => JSON.stringify([s.id, s.slug, s.versionId, s.visibility]))
    .sort()
    .join("\n");

/** Renders a workspace's current published skills as the canonical repository tree. */
export async function workspaceRepository(
  provider: WorkspaceProvider,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const listed = await provider.publishedSkills();
  const skills: WorkspaceRepositorySkill[] = [];
  for (const published of listed) {
    const snapshot = await provider.retrieve(published.id, published.versionId);
    // The listing and retrieval are separate reads; a skill republished or
    // changed in between fails the export instead of mixing two states. The
    // slug is not compared here: a cloud snapshot reports the bundle's slug,
    // and the serializer refuses a bundle whose slug is not the workspace's,
    // while a rename during the export is caught by listing again.
    if (
      snapshot.skill.id !== published.id ||
      snapshot.skill.kind !== "skill" ||
      snapshot.version.id !== published.versionId ||
      snapshot.version.state !== "published" ||
      !snapshot.version.semanticVersion
    )
      throw new RuntimeError(
        "EXPORT_STATE_CHANGED",
        "A skill changed while exporting; run the export again",
      );
    skills.push({
      id: published.id,
      slug: published.slug,
      visibility: published.visibility,
      semanticVersion: snapshot.version.semanticVersion,
      digest: snapshot.version.digest,
      bundle: snapshot.bundle,
    });
  }
  // A paged cloud listing is not a snapshot: a skill published, republished,
  // archived or reshared while it was read can be missed or stale. Listing
  // again detects any such change that completed during the export.
  if (listingKey(await provider.publishedSkills()) !== listingKey(listed))
    throw new RuntimeError(
      "EXPORT_STATE_CHANGED",
      "Skills changed while exporting; run the export again",
    );
  try {
    return await serializeWorkspaceRepository(skills);
  } catch (error) {
    if (error instanceof WorkspaceRepositoryError)
      throw new RuntimeError("EXPORT_INVALID", error.message);
    throw error;
  }
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

// --force replaces only the entries the layout owns, so a repository's .git
// directory and unrelated files such as README.md are preserved.
const MANAGED = [
  WORKSPACE_GITATTRIBUTES_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_SKILLS_DIRECTORY,
];
// One fixed name, so that an export in progress or an interrupted one is
// visible to every later run.
const WORK_DIRECTORY = ".skillplane-export";

/** Rejects a tree that is not entirely made of layout-owned, writable paths. */
function validateTree(tree: ReadonlyMap<string, Uint8Array>) {
  for (const path of tree.keys()) {
    const segments = path.split("/");
    if (
      !MANAGED.includes(segments[0] ?? "") ||
      // eslint-disable-next-line no-control-regex -- paths become file names
      /[\\\x00-\x1f]/u.test(path) ||
      segments.some((s) => !s || s === "." || s === "..")
    )
      throw new RuntimeError(
        "EXPORT_INVALID",
        `Export path ${JSON.stringify(path.slice(0, 200))} is outside the repository layout`,
      );
  }
  const problem =
    unrepresentableTreeProblem(tree.keys()) ??
    [...tree.keys()]
      .filter((path) => path.startsWith(`${WORKSPACE_SKILLS_DIRECTORY}/`))
      .map(gitControlPathProblem)
      .find(Boolean);
  if (problem)
    throw new RuntimeError(
      "EXPORT_INVALID",
      `Export cannot be written because ${problem}`,
    );
}

const errorCode = (error: unknown) =>
  (error as NodeJS.ErrnoException).code ?? "unknown error";

/**
 * Removes a tree, making its directories writable first when needed, since the
 * replaced entries may include read-only directories.
 */
function removeTree(path: string) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    const unlock = (directory: string) => {
      chmodSync(directory, 0o700);
      for (const entry of readdirSync(directory, { withFileTypes: true }))
        if (entry.isDirectory()) unlock(join(directory, entry.name));
    };
    unlock(path);
    rmSync(path, { recursive: true, force: true });
  }
}

/**
 * Writes a serialized repository tree into a directory. A directory with any
 * entry other than `.git` is refused unless `force` is set. The run first
 * creates a fixed-name work directory inside the target, which fails if it
 * already exists, so a concurrent or interrupted export makes the run refuse
 * rather than touch the other run's entries. The tree is validated and fully
 * written to that work directory first. The existing managed entries are then
 * moved aside into it and the new ones moved in; on any failure the moved
 * entries are put back, and a target this run created is removed again, so a
 * failed export leaves the target as it was.
 */
export function writeWorkspaceRepository(
  directory: string,
  tree: ReadonlyMap<string, Uint8Array>,
  force: boolean,
): string {
  validateTree(tree);
  const root = resolve(directory);
  let created: string | undefined;
  try {
    const existing = lstatIfPresent(root);
    // Only the target itself must be a real directory; its ancestors may be
    // symbolic links, such as /tmp on macOS.
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
      throw new RuntimeError(
        "EXPORT_TARGET_INVALID",
        "Export target must be a directory, not a file or symbolic link",
      );
    if (!existing) created = mkdirSync(root, { recursive: true, mode: 0o755 });
    writeTree(root, tree, force);
  } catch (error) {
    if (created) removeCreated(root, created);
    if (error instanceof RuntimeError) throw error;
    throw new RuntimeError(
      "EXPORT_WRITE_FAILED",
      `Export could not be written: ${errorCode(error)}`,
    );
  }
  return root;
}

/**
 * Removes the directories from `created` down to `root` that a failed run
 * made, deepest first, stopping at the first one that is no longer empty.
 */
function removeCreated(root: string, created: string) {
  for (let path = root; ; path = dirname(path)) {
    try {
      rmdirSync(path);
    } catch {
      return;
    }
    if (path === created || dirname(path) === path) return;
  }
}

function writeTree(
  root: string,
  tree: ReadonlyMap<string, Uint8Array>,
  force: boolean,
) {
  const work = join(root, WORK_DIRECTORY);
  try {
    // Holding this directory gives the run exclusive use of the target until
    // it is removed, so it is created before the target is inspected.
    mkdirSync(work, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== "EEXIST") throw error;
    throw new RuntimeError(
      "EXPORT_BUSY",
      `${work} exists, so another export is writing to this directory or an earlier one was interrupted. If no export is running, move any entries you want to keep out of ${join(work, "previous")}, delete ${work}, and export again`,
    );
  }
  let empty: boolean;
  try {
    empty = readdirSync(root).every(
      (name) => name === ".git" || name === WORK_DIRECTORY,
    );
  } catch (error) {
    rmdirSync(work);
    throw error;
  }
  if (!force && !empty) {
    rmdirSync(work);
    throw new RuntimeError(
      "EXPORT_EXISTS",
      "Export directory is not empty; pass --force to replace its skills",
    );
  }
  replaceEntries(root, work, tree);
}

/**
 * Stages the tree in the work directory and swaps it for the target's managed
 * entries, then removes the work directory, which releases the target. The
 * work directory is kept only when it holds the sole copy of entries that
 * could not be put back.
 */
function replaceEntries(
  root: string,
  work: string,
  tree: ReadonlyMap<string, Uint8Array>,
) {
  const staged = join(work, "new"),
    previous = join(work, "previous");
  const moved: string[] = [],
    installed: string[] = [];
  try {
    for (const [path, bytes] of tree) {
      const target = join(staged, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      // Exclusive creation never follows or replaces an existing entry.
      writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    }
    mkdirSync(previous);
    for (const name of MANAGED)
      if (lstatIfPresent(join(root, name))) {
        renameSync(join(root, name), join(previous, name));
        moved.push(name);
      }
    for (const name of MANAGED)
      if (lstatIfPresent(join(staged, name))) {
        renameSync(join(staged, name), join(root, name));
        installed.push(name);
      }
  } catch (error) {
    try {
      for (const name of installed.reverse())
        renameSync(join(root, name), join(staged, name));
      for (const name of moved.reverse())
        renameSync(join(previous, name), join(root, name));
    } catch {
      // Keep the moved entries rather than delete the only copy.
      throw new RuntimeError(
        "EXPORT_RESTORE_FAILED",
        `Export failed (${errorCode(error)}) and the previous entries could not be restored; they are in ${previous}. Move them back, then delete ${work}`,
      );
    }
    try {
      removeTree(work);
    } catch {
      throw new RuntimeError(
        "EXPORT_WRITE_FAILED",
        `Export could not be written (${errorCode(error)}); delete ${work}`,
      );
    }
    throw error;
  }
  try {
    removeTree(work);
  } catch (error) {
    throw new RuntimeError(
      "EXPORT_CLEANUP_FAILED",
      `Export was written, but ${work} could not be removed (${errorCode(error)}); delete it before committing or exporting again`,
    );
  }
}
