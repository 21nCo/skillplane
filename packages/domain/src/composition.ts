import {
  sha256Hex,
  stableJson,
  type SkillDependency,
  type VerificationClaim,
} from "@skillplane/storage";
import { satisfies, rcompare, validRange } from "semver";
import { DomainError } from "./errors.js";

export const COMPOSITION_LIMITS = {
  depth: 12,
  fanOut: 32,
  nodes: 128,
  expandedBytes: 50 * 1024 * 1024,
  attempts: 4096,
};
export interface DependencyNode {
  versionId: string;
  workspaceId: string;
  skillId: string;
  workspace: string;
  skill: string;
  semanticVersion: string;
  digest: `sha256:${string}`;
  closureDigest: `sha256:${string}`;
  expandedBytes: number;
}
export interface DependencyEdge extends SkillDependency {
  parent: string;
  child: string;
  ordinal: number;
}
export interface DependencyLock {
  formatVersion: 1;
  nodes: DependencyNode[];
  edges: DependencyEdge[];
}
export interface DependencyChoice {
  node: DependencyNode;
  lock: DependencyLock;
}
export const emptyLock = (): DependencyLock => ({
  formatVersion: 1,
  nodes: [],
  edges: [],
});
export const compositionDigest = async (
  rootDigest: string,
  lock: DependencyLock,
): Promise<`sha256:${string}`> =>
  `sha256:${await sha256Hex(new TextEncoder().encode(stableJson({ rootDigest, lock })))}`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
export function orderedDependencies(dependencies: readonly SkillDependency[]) {
  return [...dependencies].sort(
    (a, b) => (a.order ?? 0) - (b.order ?? 0) || compare(a.alias, b.alias),
  );
}
function conflict(message: string, path: string[] = []): never {
  throw new DomainError("SKILL_DEPENDENCY_CONFLICT", message, 409, {
    path: path.join(" -> "),
  });
}
export function validateLock(
  lock: DependencyLock,
  root: { workspace: string; skill: string; expandedBytes: number },
  limits = COMPOSITION_LIMITS,
): void {
  if (
    (lock as { formatVersion: unknown }).formatVersion !== 1 ||
    lock.nodes.length > limits.nodes
  )
    conflict("Dependency closure exceeds node limit");
  const nodes = new Map(lock.nodes.map((n) => [n.versionId, n]));
  if (nodes.size !== lock.nodes.length || nodes.has("$root"))
    conflict("Duplicate dependency node");
  const identities = new Map<string, string>();
  let bytes = root.expandedBytes;
  for (const node of lock.nodes) {
    const identity = `${node.workspace}/${node.skill}`;
    if (identity === `${root.workspace}/${root.skill}`)
      conflict("Dependency cycle reaches root", [identity]);
    if (identities.has(identity) && identities.get(identity) !== node.versionId)
      conflict("Incompatible locked versions", [identity]);
    identities.set(identity, node.versionId);
    if (!Number.isSafeInteger(node.expandedBytes) || node.expandedBytes < 0)
      conflict("Invalid expanded size");
    bytes += node.expandedBytes;
  }
  if (bytes > limits.expandedBytes)
    conflict("Dependency closure exceeds expanded byte limit");
  const reached = new Set<string>();
  // Bound total path expansion too: a small diamond DAG can have exponential paths.
  const memo = new Map<string, number>();
  const height = (parent: string, active: Set<string>): number => {
    if (active.has(parent)) conflict("Dependency cycle", [...active, parent]);
    if (memo.has(parent)) return memo.get(parent) ?? 0;
    const next = new Set(active).add(parent);
    const edges = lock.edges.filter((e) => e.parent === parent);
    if (
      edges.length > limits.fanOut ||
      new Set(edges.map((e) => e.alias)).size !== edges.length ||
      new Set(edges.map((e) => e.ordinal)).size !== edges.length
    )
      conflict("Invalid dependency fan-out or aliases");
    let result = 0;
    for (const edge of edges) {
      const node = nodes.get(edge.child);
      if (
        !node ||
        !validRange(edge.version) ||
        !satisfies(node.semanticVersion, edge.version) ||
        node.workspace !== edge.workspace ||
        node.skill !== edge.skill
      )
        conflict("Invalid locked dependency", [edge.alias]);
      reached.add(edge.child);
      result = Math.max(result, 1 + height(edge.child, next));
    }
    memo.set(parent, result);
    return result;
  };
  if (height("$root", new Set()) > limits.depth)
    conflict("Dependency closure exceeds depth limit");
  if (
    reached.size !== nodes.size ||
    lock.edges.some((e) => e.parent !== "$root" && !nodes.has(e.parent))
  )
    conflict("Unreachable dependency nodes");
}

/** Child locks are immutable. Backtrack only across possible direct published versions. */
export async function resolveDependencies(options: {
  dependencies: readonly SkillDependency[];
  root: { workspace: string; skill: string; expandedBytes: number };
  choices: (dependency: SkillDependency) => Promise<readonly DependencyChoice[]>;
  limits?: typeof COMPOSITION_LIMITS;
}): Promise<DependencyLock> {
  const limits = options.limits ?? COMPOSITION_LIMITS;
  const dependencies = orderedDependencies(options.dependencies);
  if (
    dependencies.length > limits.fanOut ||
    new Set(dependencies.map((d) => d.alias)).size !== dependencies.length
  )
    conflict("Dependency fan-out or duplicate aliases");
  for (const d of dependencies)
    if (!validRange(d.version))
      conflict("Invalid semantic version constraint", [d.alias]);
  const choices: (readonly DependencyChoice[])[] = [];
  for (const d of dependencies)
    choices.push(
      [...(await options.choices(d))]
        .filter((c) => satisfies(c.node.semanticVersion, d.version))
        .sort(
          (a, b) =>
            rcompare(a.node.semanticVersion, b.node.semanticVersion) ||
            compare(a.node.versionId, b.node.versionId),
        ),
    );
  let attempts = 0;
  let lastError: unknown;
  const search = (index: number, lock: DependencyLock): DependencyLock | undefined => {
    if (++attempts > limits.attempts)
      conflict("Dependency resolution search limit exceeded");
    if (index === dependencies.length) return lock;
    const d = dependencies[index];
    if (!d) conflict("Missing dependency declaration");
    for (const choice of choices[index] ?? []) {
      try {
        const nodes = new Map(lock.nodes.map((n) => [n.versionId, n]));
        for (const n of [choice.node, ...choice.lock.nodes]) {
          const existing = nodes.get(n.versionId);
          if (existing && stableJson(existing) !== stableJson(n))
            conflict("Conflicting immutable node identity");
          nodes.set(n.versionId, n);
        }
        const edges = new Map(lock.edges.map((e) => [`${e.parent}/${e.alias}`, e]));
        for (const e of choice.lock.edges) {
          const mapped = {
            ...e,
            parent: e.parent === "$root" ? choice.node.versionId : e.parent,
          };
          const key = `${mapped.parent}/${mapped.alias}`;
          if (edges.has(key) && stableJson(edges.get(key)) !== stableJson(mapped))
            conflict("Conflicting immutable edge");
          edges.set(key, mapped);
        }
        edges.set(`$root/${d.alias}`, {
          ...d,
          parent: "$root",
          child: choice.node.versionId,
          ordinal: index,
        });
        const next: DependencyLock = {
          formatVersion: 1,
          nodes: [...nodes.values()].sort((a, b) => compare(a.versionId, b.versionId)),
          edges: [...edges.values()].sort(
            (a, b) => compare(a.parent, b.parent) || a.ordinal - b.ordinal,
          ),
        };
        validateLock(next, options.root, limits);
        const result = search(index + 1, next);
        if (result) return result;
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        lastError = error;
      }
    }
    return undefined;
  };
  const result = search(0, emptyLock());
  if (!result) {
    if (lastError instanceof Error) throw lastError;
    conflict(
      "No accessible published version satisfies the dependency constraints",
      dependencies.map((d) => d.alias),
    );
  }
  const ordered: DependencyNode[] = [];
  const seen = new Set<string>();
  const visit = (parent: string) => {
    for (const edge of result.edges
      .filter((e) => e.parent === parent)
      .sort((a, b) => a.ordinal - b.ordinal)) {
      if (seen.has(edge.child)) continue;
      seen.add(edge.child);
      visit(edge.child);
      const node = result.nodes.find((n) => n.versionId === edge.child);
      if (!node) conflict("Missing dependency node");
      ordered.push(node);
    }
  };
  visit("$root");
  return { ...result, nodes: ordered };
}

export interface ResolvedModule {
  versionId: string;
  workspace: string;
  skill: string;
  digest: string;
  instructions: string;
  files: readonly {
    path: string;
    sha256: string;
    byteSize: number;
    mediaType: string;
  }[];
}
export interface ResolvedClaim extends VerificationClaim {
  namespacedId: string;
  originatingVersionId: string;
}
export interface CompositionPlan {
  root: DependencyNode;
  closureDigest: string;
  dag: DependencyLock;
  executionPlan: { modules: ResolvedModule[]; invocations: DependencyEdge[] };
  verificationPlan: { modules: ResolvedModule[]; claims: ResolvedClaim[] };
  warnings: string[];
}
