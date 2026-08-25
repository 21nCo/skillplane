import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Skill, SkillVersion } from "../../src/lib/skills/types.js";

const api = vi.hoisted(() => ({
  getSkill: vi.fn(),
  getSkillBySlug: vi.fn(),
  listSkillVersions: vi.fn(),
}));

vi.mock("../../src/lib/skills/api.js", () => api);

import { SkillDetailStore } from "../../src/lib/skills/store.svelte.js";

function skill(slug: string): Skill {
  return {
    id: `skill-${slug}`,
    workspaceId: "workspace-1",
    slug,
    name: slug,
    description: "",
    tags: [],
    visibility: "workspace",
    currentPublishedVersionId: `version-${slug}`,
    currentSemanticVersion: "1.0.0",
    archivedAt: null,
    createdAt: "2026-08-22T00:00:00.000Z",
    updatedAt: "2026-08-22T00:00:00.000Z",
  };
}

function version(slug: string): SkillVersion {
  return {
    id: `version-${slug}`,
    skillId: `skill-${slug}`,
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
});
