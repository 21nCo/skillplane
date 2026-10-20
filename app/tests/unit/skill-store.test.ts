import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill, SkillVersion } from "../../src/lib/skills/types.js";

const api = vi.hoisted(() => ({
  getSkill: vi.fn(),
  getSkillBySlug: vi.fn(),
  listSkillVersions: vi.fn(),
}));

vi.mock("../../src/lib/skills/api.js", () => api);

import { SkillDetailStore } from "../../src/lib/skills/store.svelte.js";

function skill(slug: string, workspaceId = "workspace-1", id = `skill-${slug}`): Skill {
  return {
    id,
    workspaceId,
    slug,
    name: slug,
    description: "",
    tags: [],
    visibility: "workspace",
    kind: "skill",
    currentPublishedVersionId: `version-${slug}`,
    currentSemanticVersion: "1.0.0",
    archivedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function version(
  slug: string,
  workspaceId = "workspace-1",
  skillId = `skill-${slug}`,
): SkillVersion {
  return {
    id: `version-${slug}`,
    workspaceId,
    skillId,
    status: "published",
  } as SkillVersion;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("SkillDetailStore", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("discards a refresh response after the route selects another skill", async () => {
    const oldSkill = skill("old");
    const newSkill = skill("new");
    const oldVersion = version("old");
    const newVersion = version("new");
    const refreshedOldSkill = deferred<Skill>();
    const refreshedOldVersions = deferred<SkillVersion[]>();
    let oldVersionRequests = 0;

    api.getSkillBySlug.mockImplementation(async (_workspaceId: string, slug: string) =>
      slug === oldSkill.slug ? oldSkill : newSkill,
    );
    api.getSkill.mockReturnValue(refreshedOldSkill.promise);
    api.listSkillVersions.mockImplementation(
      async (_workspaceId: string, skillId: string) => {
        if (skillId === oldSkill.id) {
          oldVersionRequests += 1;
          if (oldVersionRequests > 1) return refreshedOldVersions.promise;
          return [oldVersion];
        }
        return [newVersion];
      },
    );

    const store = new SkillDetailStore();
    await store.load("workspace-1", oldSkill.slug);
    const refresh = store.refresh();

    await store.load("workspace-1", newSkill.slug);
    refreshedOldSkill.resolve(oldSkill);
    refreshedOldVersions.resolve([oldVersion]);
    await refresh;

    expect(store.skill).toEqual(newSkill);
    expect(store.versions).toEqual([newVersion]);
  });

  it("ignores a version or refresh for a skill it no longer holds", async () => {
    api.getSkillBySlug.mockResolvedValueOnce(skill("current"));
    api.listSkillVersions.mockResolvedValueOnce([version("current")]);
    const store = new SkillDetailStore();
    await store.load("workspace-1", "current");
    api.getSkill.mockClear();
    api.listSkillVersions.mockClear();

    store.replaceVersion(version("other"));
    await store.refreshIfOwner({ workspaceId: "workspace-1", skillId: "skill-other" });

    expect(store.versions).toEqual([version("current")]);
    expect(api.getSkill).not.toHaveBeenCalled();
    expect(api.listSkillVersions).not.toHaveBeenCalled();

    store.replaceVersion({ ...version("current"), status: "rejected" });
    expect(store.versions[0]?.status).toBe("rejected");
  });

  describe("across workspaces with the same slug", () => {
    const skillA = skill("docs", "ws-a", "skill-a");
    const skillB = skill("docs", "ws-b", "skill-b");
    const versionA = version("a", "ws-a", "skill-a");
    const versionB = version("b", "ws-b", "skill-b");

    async function storeHoldingA() {
      api.getSkillBySlug.mockResolvedValueOnce(skillA);
      api.listSkillVersions.mockResolvedValueOnce([versionA]);
      const store = new SkillDetailStore();
      await store.load("ws-a", "docs");
      vi.clearAllMocks();
      return store;
    }

    it("skips a late refresh for the previous artifact while the next one loads", async () => {
      const store = await storeHoldingA();
      const destination = deferred<Skill>();
      api.getSkillBySlug.mockReturnValueOnce(destination.promise);
      api.listSkillVersions.mockResolvedValueOnce([versionB]);

      const navigation = store.load("ws-b", "docs");
      await store.refreshIfOwner({ workspaceId: "ws-a", skillId: "skill-a" });
      store.replaceVersion({ ...versionA, status: "rejected" });
      destination.resolve(skillB);
      await navigation;

      expect(api.getSkill).not.toHaveBeenCalled();
      expect(api.listSkillVersions.mock.calls).toEqual([["ws-b", "skill-b"]]);
      expect(store.skill).toEqual(skillB);
      expect(store.versions).toEqual([versionB]);
      expect(store.loading).toBe(false);
    });

    it("lets a new load supersede a refresh that is still in flight", async () => {
      const store = await storeHoldingA();
      const stale = deferred<Skill>();
      api.getSkill.mockReturnValueOnce(stale.promise);
      api.listSkillVersions.mockResolvedValueOnce([versionA]);
      const refresh = store.refresh();

      api.getSkillBySlug.mockResolvedValueOnce(skillB);
      api.listSkillVersions.mockResolvedValueOnce([versionB]);
      await store.load("ws-b", "docs");
      stale.resolve(skillA);
      await refresh;

      expect(store.skill).toEqual(skillB);
      expect(store.versions).toEqual([versionB]);
      expect(store.loading).toBe(false);
    });

    it("clears loading when a refresh runs during a reload of the same artifact", async () => {
      const store = await storeHoldingA();
      const reload = deferred<Skill>();
      api.getSkillBySlug.mockReturnValueOnce(reload.promise);
      api.getSkill.mockResolvedValueOnce(skillA);
      api.listSkillVersions.mockResolvedValue([versionA]);

      const retry = store.load("ws-a", "docs", true);
      await store.refresh();
      reload.resolve(skillA);
      await retry;

      expect(store.loading).toBe(false);
      expect(store.skill).toEqual(skillA);
      expect(api.getSkill).toHaveBeenCalledWith("ws-a", "skill-a");
    });

    it("ignores writes for the same artifact ID in another workspace", async () => {
      const store = await storeHoldingA();

      store.replaceVersion({ ...versionA, workspaceId: "ws-b", status: "rejected" });
      store.replaceSkill({ ...skillA, workspaceId: "ws-b", name: "Foreign" });
      await store.refreshIfOwner({ workspaceId: "ws-b", skillId: "skill-a" });

      expect(store.versions).toEqual([versionA]);
      expect(store.skill).toEqual(skillA);
      expect(api.getSkill).not.toHaveBeenCalled();
    });
  });
});
