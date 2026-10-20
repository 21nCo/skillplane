import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
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
    .map((s) => JSON.stringify([s.id, s.versionId, s.visibility]))
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
    // changed in between fails the export instead of mixing two states.
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
const STAGING_PREFIX = ".skillplane-export-";

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
  const problem = unrepresentableTreeProblem(tree.keys());
  if (problem)
    throw new RuntimeError(
      "EXPORT_INVALID",
      `Export cannot be written because ${problem}`,
    );
}

/**
 * Writes a serialized repository tree into a directory. A directory with any
 * entry other than `.git` is refused unless `force` is set. The tree is
 * validated and fully written to a staging directory inside the target before
 * any existing entry is replaced, so a failed export leaves the target as it was.
 */
export function writeWorkspaceRepository(
  directory: string,
  tree: ReadonlyMap<string, Uint8Array>,
  force: boolean,
): string {
  validateTree(tree);
  const root = resolve(directory);
  const existing = lstatIfPresent(root);
  // Only the target itself must be a real directory; its ancestors may be
  // symbolic links, such as /tmp on macOS.
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new RuntimeError(
      "EXPORT_TARGET_INVALID",
      "Export target must be a directory, not a file or symbolic link",
    );
  if (existing && !force && readdirSync(root).some((name) => name !== ".git"))
    throw new RuntimeError(
      "EXPORT_EXISTS",
      "Export directory is not empty; pass --force to replace its skills",
    );
  if (!existing) mkdirSync(root, { recursive: true, mode: 0o755 });
  const staging = mkdtempSync(join(root, STAGING_PREFIX));
  try {
    for (const [path, bytes] of tree) {
      const target = join(staging, ...path.split("/"));
      mkdirSync(dirname(target), { recursive: true, mode: 0o755 });
      // Exclusive creation never follows or replaces an existing entry.
      writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
    }
    for (const name of MANAGED) {
      rmSync(join(root, name), { recursive: true, force: true });
      if (lstatIfPresent(join(staging, name)))
        renameSync(join(staging, name), join(root, name));
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return root;
}
