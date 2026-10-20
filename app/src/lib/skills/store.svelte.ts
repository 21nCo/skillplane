import { getContext, setContext } from "svelte";
import { getSkill, getSkillBySlug, listSkillVersions } from "./api.js";
import type { Skill, SkillVersion } from "./types.js";

const CONTEXT_KEY = Symbol("skillplane-skill-detail");

// The artifact a committed load placed in the store.
interface ArtifactIdentity {
  readonly workspaceId: string;
  readonly skillId: string;
}

export class SkillDetailStore {
  skill = $state<Skill | null>(null);
  versions = $state<SkillVersion[]>([]);
  loading = $state(true);
  error = $state<string | null>(null);
  workspaceId = $state<string | null>(null);
  skillSlug = $state<string | null>(null);
  private loadRequest = 0;
  private refreshRequest = 0;
  private loadedKey: string | null = null;
  // Set only when a load commits and cleared when another key starts loading, so a
  // late write for the previous artifact never reaches the route's new artifact.
  private owner: ArtifactIdentity | null = null;

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
    if (!force && this.loadedKey === key && this.owner) return;
    if (this.loadedKey !== key) {
      this.owner = null;
      this.skill = null;
      this.versions = [];
    }
    this.loadedKey = key;
    this.workspaceId = workspaceId;
    this.skillSlug = skillSlug;
    this.loading = true;
    this.error = null;
    const request = ++this.loadRequest;
    // A load supersedes every refresh that started before it.
    this.refreshRequest += 1;
    try {
      const skill = await getSkillBySlug(workspaceId, skillSlug);
      const versions = await listSkillVersions(workspaceId, skill.id);
      if (request !== this.loadRequest) return;
      this.owner = { workspaceId, skillId: skill.id };
      this.skill = skill;
      this.versions = [...versions];
    } catch (cause) {
      if (request !== this.loadRequest) return;
      this.error =
        cause instanceof Error ? cause.message : "The skill could not be loaded.";
      this.owner = null;
      this.skill = null;
      this.versions = [];
    } finally {
      if (request === this.loadRequest) this.loading = false;
    }
  }

  // Re-reads the committed artifact. It has its own generation and never touches
  // loading, so it cannot discard or strand a load.
  async refresh(): Promise<void> {
    const owner = this.owner;
    if (!owner) return;
    const request = ++this.refreshRequest;
    const [refreshedSkill, versions] = await Promise.all([
      getSkill(owner.workspaceId, owner.skillId),
      listSkillVersions(owner.workspaceId, owner.skillId),
    ]);
    if (request !== this.refreshRequest || !this.owns(owner)) return;
    this.skill = refreshedSkill;
    this.versions = [...versions];
    this.error = null;
  }

  owns(identity: ArtifactIdentity): boolean {
    return (
      this.owner?.workspaceId === identity.workspaceId &&
      this.owner.skillId === identity.skillId
    );
  }

  // A late decision may arrive after this store moved to another artifact; only the
  // artifact it belongs to is refreshed.
  async refreshIfOwner(identity: ArtifactIdentity): Promise<void> {
    if (this.owns(identity)) await this.refresh();
  }

  replaceSkill(skill: Skill): void {
    if (!this.owns({ workspaceId: skill.workspaceId, skillId: skill.id })) return;
    this.skill = skill;
  }

  // A version of another artifact is ignored, so it never enters this history.
  replaceVersion(version: SkillVersion): void {
    if (!this.owns(version)) return;
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
