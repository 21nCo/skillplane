import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  serializeWorkspaceRepository,
  WORKSPACE_GITATTRIBUTES_PATH,
  WORKSPACE_MANIFEST_PATH,
  WORKSPACE_SKILLS_DIRECTORY,
  WorkspaceRepositoryError,
  type WorkspaceRepositorySkill,
} from "@skillplane/storage";
import { RuntimeError, type WorkspaceProvider } from "./contracts.js";
import { safeDirectory } from "./files.js";

/** Renders a workspace's current published skills as the canonical repository tree. */
export async function workspaceRepository(
  provider: WorkspaceProvider,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const skills: WorkspaceRepositorySkill[] = [];
  for (const published of await provider.publishedSkills()) {
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

/**
 * Writes a serialized repository tree into a directory. A directory with any
 * entry other than `.git` is refused unless `force` is set.
 */
export function writeWorkspaceRepository(
  directory: string,
  tree: ReadonlyMap<string, Uint8Array>,
  force: boolean,
): string {
  const root = resolve(directory);
  const existing = lstatIfPresent(root);
  if (existing && (!existing.isDirectory() || existing.isSymbolicLink()))
    throw new RuntimeError(
      "UNSAFE_DIRECTORY",
      "Export target must be a directory, not a file or symlink",
    );
  if (existing && !force && readdirSync(root).some((name) => name !== ".git"))
    throw new RuntimeError(
      "EXPORT_EXISTS",
      "Export directory is not empty; pass --force to replace its skills",
    );
  safeDirectory(root);
  for (const name of MANAGED)
    rmSync(join(root, name), { recursive: true, force: true });
  for (const [path, bytes] of tree) {
    const target = join(root, ...path.split("/"));
    const parent = dirname(target);
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true, mode: 0o755 });
    // Exclusive creation never follows or replaces an entry created meanwhile.
    writeFileSync(target, bytes, { flag: "wx", mode: 0o644 });
  }
  return root;
}
