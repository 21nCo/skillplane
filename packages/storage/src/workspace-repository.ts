import { canonicalizeBundleFiles } from "./canonicalize.js";
import {
  GIT_IMPORT_LIMITS,
  gitImportSkillProblem,
  gitSkillRoots,
  gitTreeEntries,
  nestedGitSkillRoot,
} from "./git-import.js";
import { bundleKind, type CanonicalBundle } from "./manifest.js";
import { bundlePathCollisionKey, bytewisePathCompare } from "./paths.js";

/**
 * The canonical workspace repository layout (SKI-28): one `skills/<slug>/`
 * directory per current published skill, holding exactly that version's
 * canonical bundle files, plus a root `skillplane.workspace.json` index. The
 * Git source importer reads each skill directory back to the same digest.
 */
export const WORKSPACE_REPOSITORY_FORMAT_VERSION = 1 as const;
export const WORKSPACE_MANIFEST_PATH = "skillplane.workspace.json";
export const WORKSPACE_SKILLS_DIRECTORY = "skills";
/**
 * Bundle files are exported byte-for-byte, so Git must never rewrite them on
 * checkout or commit; otherwise a directory could stop canonicalizing to its
 * published digest. Git resolves each attribute separately, so this file
 * unsets every attribute that changes content (line-ending conversion, clean
 * and smudge filters, `$Id$` expansion and re-encoding) rather than only
 * `text`; a user's `core.attributesFile` cannot set any of them back. Skill
 * directories may not hold their own Git control files, so nothing in the
 * tree overrides this one.
 */
export const WORKSPACE_GITATTRIBUTES_PATH = ".gitattributes";
const GITATTRIBUTES = "* -text -filter -ident -working-tree-encoding\n";

export type WorkspaceRepositoryVisibility = "private" | "workspace" | "public";

export interface WorkspaceRepositorySkill {
  /** Stable workspace skill ID. */
  readonly id: string;
  /** The workspace's slug for the skill, which names its directory. */
  readonly slug: string;
  readonly visibility: WorkspaceRepositoryVisibility;
  /** Semantic version of the skill's current published version. */
  readonly semanticVersion: string;
  /** Digest the workspace records for that published version. */
  readonly digest: string;
  /** The published version's canonical bundle. */
  readonly bundle: CanonicalBundle;
}

export interface WorkspaceManifestSkill {
  readonly id: string;
  readonly slug: string;
  readonly path: string;
  readonly visibility: WorkspaceRepositoryVisibility;
  readonly tags: readonly string[];
  readonly semanticVersion: string;
  readonly digest: `sha256:${string}`;
}

export interface WorkspaceManifest {
  readonly formatVersion: typeof WORKSPACE_REPOSITORY_FORMAT_VERSION;
  readonly skills: readonly WorkspaceManifestSkill[];
}

export class WorkspaceRepositoryError extends Error {
  readonly code = "WORKSPACE_EXPORT_INVALID";

  constructor(message: string) {
    super(message);
    this.name = "WorkspaceRepositoryError";
  }
}

const VISIBILITIES = new Set<string>(["private", "workspace", "public"]);
const SEMANTIC_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const encoder = new TextEncoder();

/** Recursively orders object keys by UTF-8 bytes so output never depends on locale. */
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => bytewisePathCompare(left, right))
        .map(([key, entry]) => [key, sortKeys(entry)]),
    );
  return value;
}

/**
 * The first reason a set of slash-separated file paths cannot be written as a
 * directory tree, or null. A path that is also another path's ancestor, or two
 * entries that differ only by Unicode normalization or case, cannot coexist on
 * disk or in Git on case-insensitive file systems.
 */
export function unrepresentableTreeProblem(paths: Iterable<string>): string | null {
  const entries = new Map<string, { path: string; directory: boolean }>();
  const claim = (path: string, directory: boolean) => {
    const key = bundlePathCollisionKey(path);
    const existing = entries.get(key);
    if (!existing) {
      entries.set(key, { path, directory });
      return null;
    }
    if (existing.path === path && existing.directory && directory) return null;
    return existing.directory !== directory
      ? `${path} is both a file and a directory`
      : `${existing.path} and ${path} differ only by case or Unicode normalization`;
  };
  for (const path of paths) {
    const segments = path.split("/");
    for (let end = 1; end < segments.length; end += 1) {
      const problem = claim(segments.slice(0, end).join("/"), true);
      if (problem) return problem;
    }
    const problem = claim(path, false);
    if (problem) return problem;
  }
  return null;
}

// Git control files and their NTFS 8.3 short names, as Git's own path checks
// list them. Git would ignore, rewrite or refuse such a file instead of
// committing its bytes.
const GIT_CONTROL_NAMES = new Set([
  ".git",
  ".gitattributes",
  ".gitignore",
  ".gitmodules",
]);
const GIT_SHORT_NAME = /^(?:git|gitmod|gitatt|gitign|gi7eba|gi7d29|gi250a)~[0-9]+$/u;
// Code points HFS+ ignores when comparing names, so ".g\u200cit" is ".git" there.
const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;

/**
 * Why Git would not commit a skill file path byte for byte, or null. A path
 * segment that is, or on NTFS or HFS+ aliases, `.git`, `.gitattributes`,
 * `.gitignore` or `.gitmodules` is never tracked as a plain file, or changes
 * how Git stores the files around it.
 */
export function gitControlPathProblem(path: string): string | null {
  for (const segment of path.split("/")) {
    const name = segment
      .replace(HFS_IGNORABLE, "")
      .toLowerCase()
      .replace(/:.*$/u, "")
      .replace(/[. ]+$/u, "");
    if (GIT_CONTROL_NAMES.has(name) || GIT_SHORT_NAME.test(name))
      return `${path} is a Git control path`;
  }
  return null;
}

/** Two-space indented JSON with sorted keys, LF line endings and a final newline. */
export function workspaceManifestJson(manifest: WorkspaceManifest): string {
  return `${JSON.stringify(sortKeys(manifest), null, 2)}\n`;
}

/**
 * Serializes current published skills into the canonical repository tree as
 * repository-relative path to bytes, in bytewise path order. The output depends
 * only on the input skills, never on input order, clock or time zone. Every
 * bundle is re-canonicalized from its own files, and the call fails rather than
 * exporting a directory that would not reproduce the recorded digest.
 */
export async function serializeWorkspaceRepository(
  skills: readonly WorkspaceRepositorySkill[],
): Promise<ReadonlyMap<string, Uint8Array>> {
  const entries: { manifest: WorkspaceManifestSkill; bundle: CanonicalBundle }[] = [];
  const ids = new Set<string>(),
    slugs = new Set<string>();
  for (const skill of skills) {
    if (
      typeof skill.id !== "string" ||
      !skill.id ||
      skill.id.length > 200 ||
      // eslint-disable-next-line no-control-regex -- IDs are written into the manifest
      /[\x00-\x1f\x7f]/u.test(skill.id)
    )
      throw new WorkspaceRepositoryError("Skill ID is invalid");
    if (ids.has(skill.id))
      throw new WorkspaceRepositoryError(`Skill ${skill.id} is listed more than once`);
    ids.add(skill.id);
    if (bundleKind(skill.bundle.skill) !== "skill")
      throw new WorkspaceRepositoryError(
        `Skill ${skill.id} is an instructions document, which the repository layout excludes`,
      );
    if (!VISIBILITIES.has(skill.visibility))
      throw new WorkspaceRepositoryError(`Skill ${skill.id} has an invalid visibility`);
    if (
      typeof skill.semanticVersion !== "string" ||
      skill.semanticVersion.length > 160 ||
      !SEMANTIC_VERSION.test(skill.semanticVersion)
    )
      throw new WorkspaceRepositoryError(
        `Skill ${skill.id} has no valid published semantic version`,
      );
    const bundle = await canonicalizeBundleFiles({
      skill: skill.bundle.skill,
      files: skill.bundle.files,
    });
    if (bundle.digest !== skill.digest || skill.bundle.digest !== skill.digest)
      throw new WorkspaceRepositoryError(
        `Skill ${skill.id} bundle does not match its published digest`,
      );
    const slug = skill.slug;
    // The importer matches a bound skill by the bundle's slug, so a bundle
    // naming another slug would read back as a conflict. Rewriting skill.json
    // would change the digest instead.
    if (bundle.skill.slug !== slug)
      throw new WorkspaceRepositoryError(
        `Skill ${skill.id} cannot be exported because its published bundle declares the slug ${bundle.skill.slug}, not the workspace slug ${JSON.stringify(slug.slice(0, 100))}`,
      );
    // Never write a directory that cannot exist on disk, that Git would not
    // commit byte for byte, or that the Git source importer would reject,
    // since it could not read back as a no-op.
    const problem =
      unrepresentableTreeProblem(bundle.files.keys()) ??
      [...bundle.files.keys()].map(gitControlPathProblem).find(Boolean) ??
      (await gitImportSkillProblem(bundle.files));
    if (problem)
      throw new WorkspaceRepositoryError(
        `Skill ${slug} (${skill.id}) cannot be exported because ${problem}`,
      );
    if (slugs.has(slug))
      throw new WorkspaceRepositoryError(`Several skills use the slug ${slug}`);
    slugs.add(slug);
    entries.push({
      bundle,
      manifest: {
        id: skill.id,
        slug,
        path: `${WORKSPACE_SKILLS_DIRECTORY}/${slug}`,
        visibility: skill.visibility,
        tags: [...bundle.skill.tags],
        semanticVersion: skill.semanticVersion,
        digest: bundle.digest,
      },
    });
  }
  entries.sort((left, right) =>
    bytewisePathCompare(left.manifest.slug, right.manifest.slug),
  );
  const tree = new Map<string, Uint8Array>();
  tree.set(WORKSPACE_GITATTRIBUTES_PATH, encoder.encode(GITATTRIBUTES));
  tree.set(
    WORKSPACE_MANIFEST_PATH,
    encoder.encode(
      workspaceManifestJson({
        formatVersion: WORKSPACE_REPOSITORY_FORMAT_VERSION,
        skills: entries.map((entry) => entry.manifest),
      }),
    ),
  );
  for (const { manifest, bundle } of entries)
    for (const [path, bytes] of bundle.files) {
      const copy = new Uint8Array(bytes.byteLength);
      copy.set(bytes);
      tree.set(`${manifest.path}/${path}`, copy);
    }
  // The importer must discover each skill exactly once, at its own directory.
  // A file or directory named SKILL.md inside a skill would be discovered as a
  // nested root, which makes the whole skill directory invalid.
  const gitEntries = gitTreeEntries(tree.keys());
  // The importer refuses an oversized repository tree before it selects any
  // path, so no source scope could read such an export back.
  if (gitEntries.length > GIT_IMPORT_LIMITS.treeEntries)
    throw new WorkspaceRepositoryError(
      `The repository tree would have ${String(gitEntries.length)} Git entries, more than the ${String(GIT_IMPORT_LIMITS.treeEntries)} the Git source importer reads; archive or slim skills before exporting`,
    );
  const roots = gitSkillRoots(gitEntries);
  for (const { manifest } of entries) {
    const nested = nestedGitSkillRoot(manifest.path, roots);
    if (nested !== undefined || !roots.includes(manifest.path))
      throw new WorkspaceRepositoryError(
        `Skill ${manifest.slug} (${manifest.id}) cannot be exported because ${
          nested === undefined
            ? `the Git importer would not discover ${manifest.path}`
            : `${nested}/SKILL.md would be discovered as a nested skill root`
        }`,
      );
  }
  return new Map(
    [...tree.entries()].sort(([left], [right]) => bytewisePathCompare(left, right)),
  );
}
