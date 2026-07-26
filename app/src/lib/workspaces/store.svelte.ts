import { browser } from "$app/environment";
import { apiRequest } from "$lib/api/client.js";
import { getContext, setContext } from "svelte";

export type WorkspaceRole = "viewer" | "editor" | "admin" | "owner";

export interface Workspace {
  readonly id: string;
  readonly kind: "personal" | "organization";
  readonly slug: string;
  readonly name: string;
  readonly role: WorkspaceRole;
  readonly updatedAt: string;
}

const CONTEXT_KEY = Symbol("skillplane-workspaces");
const STORAGE_KEY = "skillplane.active-workspace";

export class WorkspaceStore {
  workspaces = $state<Workspace[]>([]);
  activeId = $state<string | null>(null);
  loading = $state(true);
  error = $state<string | null>(null);

  get active(): Workspace | null {
    return this.workspaces.find((workspace) => workspace.id === this.activeId) ?? null;
  }

  async load(): Promise<void> {
    this.loading = true;
    this.error = null;
    try {
      const data = await apiRequest<{ workspaces: Workspace[] }>("/api/v1/workspaces");
      this.workspaces = data.workspaces;
      const remembered = browser ? localStorage.getItem(STORAGE_KEY) : null;
      const rememberedWorkspace = remembered
        ? data.workspaces.find((workspace) => workspace.id === remembered)
        : undefined;
      const next = rememberedWorkspace ?? data.workspaces.at(0);
      this.activeId = next ? next.id : null;
      if (next && browser) {
        localStorage.setItem(STORAGE_KEY, next.id);
      }
    } catch (error) {
      this.error =
        error instanceof Error ? error.message : "Workspaces could not be loaded.";
    } finally {
      this.loading = false;
    }
  }

  select(workspaceId: string): void {
    if (!this.workspaces.some((workspace) => workspace.id === workspaceId)) return;
    this.activeId = workspaceId;
    localStorage.setItem(STORAGE_KEY, workspaceId);
  }

  async refresh(preferredId?: string): Promise<void> {
    if (preferredId) localStorage.setItem(STORAGE_KEY, preferredId);
    await this.load();
  }
}

export function provideWorkspaceStore(): WorkspaceStore {
  const store = new WorkspaceStore();
  setContext(CONTEXT_KEY, store);
  return store;
}

export function useWorkspaceStore(): WorkspaceStore {
  return getContext<WorkspaceStore>(CONTEXT_KEY);
}
