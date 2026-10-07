<script lang="ts">
  import { resolve } from "$app/paths";
  import { SvelteURLSearchParams } from "svelte/reactivity";
  import { page } from "$app/state";
  import { Button, Input, Select, EmptyState } from "@skillplane/ui";
  import { apiRequest } from "$lib/api/client.js";
  import { groupRequest, type Group, type Member } from "$lib/groups/api.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import type { Skill } from "$lib/skills/types.js";
  const store = useWorkspaceStore();
  const workspace = $derived(
    store.workspaces.find((w) => w.slug === page.params.workspaceSlug) ?? null,
  );
  const canManage = $derived(
    workspace?.role === "admin" || workspace?.role === "owner",
  );
  let groups = $state<Group[]>([]),
    selected = $state<Group | null>(null),
    name = $state(""),
    description = $state(""),
    includeArchived = $state(false),
    busy = $state(false),
    error = $state(""),
    loaded = $state("");
  let groupCursor = $state<string | null>(null),
    skills = $state<Skill[]>([]),
    skillCursor = $state<string | null>(null),
    members = $state<Member[]>([]),
    memberCursor = $state<string | null>(null),
    roster = $state<Member[]>([]),
    available = $state<Skill[]>([]),
    targetSkill = $state(""),
    targetMember = $state(""),
    query = $state("");
  function isCurrent(workspaceId: string, groupId?: string) {
    return (
      workspace?.id === workspaceId &&
      (groupId === undefined || selected?.id === groupId)
    );
  }
  let creationKey = crypto.randomUUID();
  async function load(more = false) {
    if (!workspace) return;
    const workspaceId = workspace.id;
    const result = await groupRequest<{ groups: Group[]; nextCursor: string | null }>(
      workspace.id,
      `?state=${includeArchived ? "all" : "active"}${more && groupCursor ? `&cursor=${encodeURIComponent(groupCursor)}` : ""}`,
    );
    if (!isCurrent(workspaceId)) return;
    groups = more ? [...groups, ...result.groups] : result.groups;
    groupCursor = result.nextCursor;
  }
  async function detail(group: Group) {
    if (!workspace) return;
    const workspaceId = workspace.id;
    selected = group;
    name = group.name;
    description = group.description;
    skills = [];
    members = [];
    skillCursor = null;
    memberCursor = null;
    await Promise.all([loadSkills(), loadMembers()]);
    if (canManage) {
      const r = await apiRequest<{ members: Member[] }>(
        `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/members`,
      );
      if (!isCurrent(workspaceId, group.id)) return;
      roster = r.members;
      await searchSkills();
    }
  }
  async function loadSkills(more = false) {
    if (!workspace || !selected) return;
    const workspaceId = workspace.id,
      groupId = selected.id;
    const q = new SvelteURLSearchParams({ groupId: selected.id, limit: "20" });
    if (more && skillCursor) q.set("cursor", skillCursor);
    const r = await apiRequest<{ skills: Skill[]; nextCursor: string | null }>(
      `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/skills?${q}`,
    );
    if (!isCurrent(workspaceId, groupId)) return;
    skills = more ? [...skills, ...r.skills] : r.skills;
    skillCursor = r.nextCursor;
  }
  async function loadMembers(more = false) {
    if (!workspace || !selected) return;
    const workspaceId = workspace.id,
      groupId = selected.id;
    const r = await groupRequest<{ members: Member[]; nextCursor: string | null }>(
      workspace.id,
      `/${encodeURIComponent(selected.id)}/members${more && memberCursor ? `?cursor=${encodeURIComponent(memberCursor)}` : ""}`,
    );
    if (!isCurrent(workspaceId, groupId)) return;
    members = more ? [...members, ...r.members] : r.members;
    memberCursor = r.nextCursor;
  }
  async function searchSkills() {
    if (!workspace) return;
    const workspaceId = workspace.id;
    const r = await apiRequest<{ skills: Skill[] }>(
      `/api/v1/workspaces/${encodeURIComponent(workspace.id)}/skills?${new SvelteURLSearchParams({ q: query, limit: "100" })}`,
    );
    if (!isCurrent(workspaceId)) return;
    available = r.skills;
    targetSkill = "";
  }
  async function run(fn: () => Promise<void>) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await fn();
    } catch (e) {
      error = e instanceof Error ? e.message : "The change failed";
    } finally {
      busy = false;
    }
  }
  async function save(archived = Boolean(selected?.archivedAt)) {
    if (!workspace) return;
    const workspaceId = workspace.id;
    const r = await groupRequest<{ group: Group }>(
      workspace.id,
      selected ? `/${encodeURIComponent(selected.id)}` : "",
      selected ? "PATCH" : "POST",
      {
        name,
        description,
        ...(selected ? { expectedRevision: selected.revision, archived } : {}),
      },
      creationKey,
    );
    if (!isCurrent(workspaceId)) return;
    creationKey = crypto.randomUUID();
    await load();
    await detail(r.group);
  }
  async function assign(kind: "skills" | "members", id: string, add: boolean) {
    if (!workspace || !selected || !id) return;
    await groupRequest(
      workspace.id,
      `/${encodeURIComponent(selected.id)}/${kind}/${encodeURIComponent(id)}`,
      add ? "PUT" : "DELETE",
    );
    await detail(selected);
  }
  $effect(() => {
    if (workspace && loaded !== workspace.id) {
      loaded = workspace.id;
      selected = null;
      groups = [];
      error = "";
      creationKey = crypto.randomUUID();
      void load().catch((e: unknown) => {
        error = e instanceof Error ? e.message : "Groups could not be loaded";
      });
    }
  });
</script>

<svelte:head
  ><title>Skill groups · {workspace?.name ?? "Skillplane"}</title></svelte:head
>
<main class="groups-page">
  <h1>Skill groups</h1>
  <p>
    Organize skills and members by domain. Group membership does not grant access or
    change workspace roles.
  </p>
  {#if error}<p role="alert">{error}</p>{/if}
  <label
    ><input
      type="checkbox"
      bind:checked={includeArchived}
      onchange={() => void run(() => load())}
    /> Include archived groups</label
  >
  {#if canManage}<Button
      variant="secondary"
      disabled={busy}
      onclick={() => {
        selected = null;
        creationKey = crypto.randomUUID();
        name = "";
        description = "";
      }}>New group</Button
    >{/if}
  <nav aria-label="Skill groups">
    {#each groups as g (g.id)}<Button
        variant="secondary"
        disabled={busy}
        onclick={() => void run(() => detail(g))}
        >{g.name}{g.archivedAt ? " (archived)" : ""}</Button
      >{/each}
  </nav>
  {#if groupCursor}<Button disabled={busy} onclick={() => void run(() => load(true))}
      >Load more groups</Button
    >{/if}
  {#if !groups.length}<EmptyState
      title="No skill groups"
      description="Create a group such as Design, Marketing, Development, or Sales."
    />{/if}
  {#if canManage}<form
      onsubmit={(e) => {
        e.preventDefault();
        void run(() => save());
      }}
    >
      <h2>{selected ? "Edit group" : "Create group"}</h2>
      <Input label="Name" bind:value={name} required maxlength={120} /><Input
        label="Description"
        bind:value={description}
        maxlength={2000}
      /><Button type="submit" disabled={busy}>Save group</Button>{#if selected}<Button
          variant="secondary"
          disabled={busy}
          onclick={() => void run(() => save(!selected?.archivedAt))}
          >{selected.archivedAt ? "Restore" : "Archive"}</Button
        >{/if}
    </form>{/if}
  {#if selected}<section aria-label="Group detail">
      <h2>{selected.name}</h2>
      <p>{selected.description}</p>
      <h3>Skills</h3>
      <ul>
        {#each skills as skill (skill.id)}<li>
            <a
              href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]", {
                workspaceSlug: workspace?.slug ?? "",
                skillSlug: skill.slug,
              })}>{skill.name}</a
            >{#if canManage && !selected.archivedAt}<Button
                variant="ghost"
                disabled={busy}
                onclick={() => void run(() => assign("skills", skill.id, false))}
                >Remove {skill.name}</Button
              >{/if}
          </li>{/each}
      </ul>
      {#if skillCursor}<Button
          disabled={busy}
          onclick={() => void run(() => loadSkills(true))}>Load more skills</Button
        >{/if}
      <h3>Members</h3>
      <ul>
        {#each members as m (m.userId)}<li>
            {m.displayName ?? m.email ?? m.userId} ({m.role}){#if canManage && !selected.archivedAt}<Button
                variant="ghost"
                disabled={busy}
                onclick={() => void run(() => assign("members", m.userId, false))}
                >Remove member</Button
              >{/if}
          </li>{/each}
      </ul>
      {#if memberCursor}<Button
          disabled={busy}
          onclick={() => void run(() => loadMembers(true))}>Load more members</Button
        >{/if}
      {#if canManage && !selected.archivedAt}<form
          onsubmit={(e) => {
            e.preventDefault();
            void run(() => searchSkills());
          }}
        >
          <Input label="Find skills to add" bind:value={query} /><Button
            type="submit"
            disabled={busy}>Search</Button
          >
        </form>
        <Select
          label="Skill"
          bind:value={targetSkill}
          options={[
            { value: "", label: "Choose a skill" },
            ...available.map((s) => ({ value: s.id, label: s.name })),
          ]}
        /><Button
          disabled={busy || !targetSkill}
          onclick={() => void run(() => assign("skills", targetSkill, true))}
          >Add skill</Button
        ><Select
          label="Member"
          bind:value={targetMember}
          options={[
            { value: "", label: "Choose a member" },
            ...roster.map((m) => ({
              value: m.userId,
              label: m.displayName ?? m.email ?? m.userId,
            })),
          ]}
        /><Button
          disabled={busy || !targetMember}
          onclick={() => void run(() => assign("members", targetMember, true))}
          >Add member</Button
        >{/if}
    </section>{/if}
</main>

<style>
  .groups-page {
    max-width: 70rem;
    margin: 0 auto;
    padding: 2rem;
    display: grid;
    gap: 1rem;
  }
  nav,
  form,
  section {
    display: grid;
    gap: 0.75rem;
  }
  nav {
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  }
  li {
    display: flex;
    gap: 1rem;
    align-items: center;
    padding: 0.5rem 0;
  }
</style>
