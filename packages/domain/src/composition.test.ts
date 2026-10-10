import { describe, it, expect } from "vitest";
import {
  resolveDependencies,
  emptyLock,
  compositionDigest,
  COMPOSITION_LIMITS,
  type DependencyChoice,
  type DependencyLock,
} from "./composition.js";
import type { SkillDependency } from "@skillplane/storage";
const digest = `sha256:${"a".repeat(64)}` as const;
const root = { workspace: "acme", skill: "root", expandedBytes: 10 };
const dep = (skill: string, version = "*", alias = skill): SkillDependency => ({
  workspace: "acme",
  skill,
  version,
  alias,
  scope: "both",
  mode: "include",
  required: true,
});
const choice = (
  skill: string,
  version = "1.0.0",
  lock = emptyLock(),
): DependencyChoice => ({
  node: {
    versionId: `v:${skill}:${version}`,
    workspaceId: "w",
    workspace: "acme",
    skillId: `s:${skill}`,
    skill,
    semanticVersion: version,
    digest,
    closureDigest: digest,
    expandedBytes: 100,
  },
  lock,
});
const locked = (child: DependencyChoice): DependencyLock => ({
  formatVersion: 1,
  nodes: [child.node, ...child.lock.nodes],
  edges: [
    {
      ...dep(child.node.skill),
      parent: "$root",
      child: child.node.versionId,
      ordinal: 0,
    },
    ...child.lock.edges.map((e) => ({
      ...e,
      parent: e.parent === "$root" ? child.node.versionId : e.parent,
    })),
  ],
});
describe("immutable dependency resolution", () => {
  it("orders aliases deterministically and retains a diamond once", async () => {
    const leaf = choice("leaf"),
      a = choice("a", "1.0.0", locked(leaf)),
      b = choice("b", "1.0.0", locked(leaf));
    const choices = async (d: SkillDependency) => (d.skill === "a" ? [a] : [b]);
    const first = await resolveDependencies({
      dependencies: [dep("b"), dep("a")],
      root,
      choices,
    });
    const second = await resolveDependencies({
      dependencies: [dep("a"), dep("b")],
      root,
      choices,
    });
    expect(first).toEqual(second);
    expect(first.nodes).toHaveLength(3);
    expect(await compositionDigest(digest, first)).toEqual(
      await compositionDigest(digest, second),
    );
    expect(await compositionDigest(`sha256:${"b".repeat(64)}`, first)).not.toEqual(
      await compositionDigest(digest, first),
    );
  });
  it("backtracks across direct versions to satisfy an exact child lock", async () => {
    const old = choice("leaf"),
      newer = choice("leaf", "1.1.0"),
      a = choice("a", "1.0.0", locked(old));
    const result = await resolveDependencies({
      dependencies: [dep("leaf", "^1.0.0", "a-leaf"), dep("a", "*", "z-parent")],
      root,
      choices: async (d) => (d.skill === "leaf" ? [newer, old] : [a]),
    });
    expect(result.nodes.find((n) => n.skill === "leaf")?.semanticVersion).toBe("1.0.0");
  });
  it("rejects incompatible transitive pins", async () => {
    const a = choice("a", "1.0.0", locked(choice("leaf"))),
      b = choice("b", "1.0.0", locked(choice("leaf", "2.0.0")));
    await expect(
      resolveDependencies({
        dependencies: [dep("a"), dep("b")],
        root,
        choices: async (d) => (d.skill === "a" ? [a] : [b]),
      }),
    ).rejects.toThrow("Incompatible locked versions");
  });
  it("rejects cycles through the root skill even at a different version", async () => {
    const c = choice("a", "1.0.0", locked(choice("root")));
    await expect(
      resolveDependencies({ dependencies: [dep("a")], root, choices: async () => [c] }),
    ).rejects.toThrow("cycle");
  });
  it.each(["depth", "fanOut", "nodes", "expandedBytes"] as const)(
    "enforces configured %s bounds",
    async (key) => {
      const c = choice("a", "1.0.0", locked(choice("leaf")));
      await expect(
        resolveDependencies({
          dependencies: [dep("a")],
          root,
          choices: async () => [c],
          limits: { ...COMPOSITION_LIMITS, [key]: 0 },
        }),
      ).rejects.toThrow();
    },
  );
  it("rejects invalid ranges, duplicate aliases and unavailable dependencies", async () => {
    for (const dependencies of [
      [dep("a", "not a range")],
      [dep("a"), dep("b", "*", "a")],
      [dep("a")],
    ]) {
      await expect(
        resolveDependencies({ dependencies, root, choices: async () => [] }),
      ).rejects.toThrow();
    }
  });
});
