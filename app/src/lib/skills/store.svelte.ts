import { getContext, setContext } from "svelte";
import { getSkill, getSkillBySlug, listSkillVersions } from "./api.js";
import type { Skill, SkillVersion } from "./types.js";

const CONTEXT_KEY = Symbol("skillplane-skill-detail");

export class SkillDetailStore {
  skill = $state<Skill | null>(null);
  versions = $state<SkillVersion[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  workspaceId = $state<string | null>(null);
  skillSlug = $state<string | null>(null);
  private request = 0;
  private loadedKey: string | null = null;

  get currentVersion(): SkillVersion | null {
    const currentId = this.skill?.currentPublishedVersionId;
    return (
      this.versions.find((version) => version.id === currentId) ??
      this.versions.find((version) => version.status === "published") ??
      null
    );
  }

  async load(workspaceId: string, skillSlug: string, force = false): Promise<void> {
    const key = `${workspaceId}:${skillSlug}`;
    if (!force && this.loadedKey === key && this.skill) return;
    this.loadedKey = key;
    this.workspaceId = workspaceId;
    this.skillSlug = skillSlug;
    this.loading = true;
    this.error = null;
    const request = ++this.request;
    try {
      const skill = await getSkillBySlug(workspaceId, skillSlug);
      const versions = await listSkillVersions(workspaceId, skill.id);
      if (request !== this.request) return;
      this.skill = skill;
      this.versions = [...versions];
    } catch (cause) {
      if (request !== this.request) return;
      this.error =
        cause instanceof Error ? cause.message : "The skill could not be loaded.";
      this.skill = null;
      this.versions = [];
    } finally {
      if (request === this.request) this.loading = false;
    }
  }

  async refresh(): Promise<void> {
    const workspaceId = this.workspaceId;
    const skill = this.skill;
    const skillSlug = this.skillSlug;
    const loadedKey = this.loadedKey;
    if (
      !workspaceId ||
      !skill ||
      !skillSlug ||
      loadedKey !== `${workspaceId}:${skillSlug}` ||
      skill.slug !== skillSlug
    ) {
      return;
    }
    const request = ++this.request;
    const [refreshedSkill, versions] = await Promise.all([
      getSkill(workspaceId, skill.id),
      listSkillVersions(workspaceId, skill.id),
    ]);
    if (request !== this.request || this.loadedKey !== loadedKey) return;
    this.skill = refreshedSkill;
    this.versions = [...versions];
    this.error = null;
  }

  replaceSkill(skill: Skill): void {
    this.skill = skill;
  }

  replaceVersion(version: SkillVersion): void {
    const index = this.versions.findIndex((entry) => entry.id === version.id);
    if (index === -1) {
      this.versions = [version, ...this.versions];
      return;
    }
    this.versions[index] = version;
  }
}

export function provideSkillDetailStore(): SkillDetailStore {
  const store = new SkillDetailStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useSkillDetailStore(): SkillDetailStore {
  return getContext<SkillDetailStore>(CONTEXT_KEY);
}
