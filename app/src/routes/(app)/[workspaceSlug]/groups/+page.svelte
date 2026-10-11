<script lang="ts">
  import { resolve } from "$app/paths";
  import { untrack } from "svelte";
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
    skills = $state<
      (Pick<Skill, "id" | "name" | "slug"> & { archivedAt: string | null })[]
    >([]),
    skillCursor = $state<string | null>(null),
    members = $state<Member[]>([]),
    memberCursor = $state<string | null>(null),
    roster = $state<Member[]>([]),
    available = $state<Skill[]>([]),
    targetSkill = $state(""),
    targetMember = $state(""),
    query = $state("");
  // Every async continuation captures a token and may touch page state only while
  // it is current. Each navigation (workspace or member filter) starts a new
  // navigation generation, and each group selection a new detail generation, so a
  // late response can never match a newer view even when its keys repeat.
  let navigation = 0,
    detailGeneration = 0,
    listGeneration = 0;
  interface Token {
    readonly navigation: number;
    readonly detail: number;
    readonly workspaceId: string;
  }
  function token(workspaceId: string): Token {
    return { navigation, detail: detailGeneration, workspaceId };
  }
  function inNavigation(t: Token) {
    return t.navigation === navigation && workspace?.id === t.workspaceId;
  }
  function inDetail(t: Token) {
    return inNavigation(t) && t.detail === detailGeneration;
  }
  // Operations still running, including superseded ones; exposed on the page so a
  // caller can tell when every continuation has finished.
  let pendingOperations = $state(0);
  async function tracked(fn: () => Promise<void>) {
    pendingOperations += 1;
    try {
      await fn();
    } finally {
      pendingOperations -= 1;
    }
  }
  let creationKey = crypto.randomUUID();
  let listLoaded = $state(false),
    listLoading = $state(false);
  async function load(more = false) {
    if (!workspace) return;
    const t = token(workspace.id),
      memberId = page.url.searchParams.get("memberId") ?? "",
      archived = includeArchived,
      generation = ++listGeneration;
    const current = () => inNavigation(t) && generation === listGeneration;
    if (!more) {
      groupCursor = null;
      listLoaded = false;
    }
    listLoading = true;
    try {
      const result = await groupRequest<{ groups: Group[]; nextCursor: string | null }>(
        t.workspaceId,
        `?${memberId ? `userId=${encodeURIComponent(memberId)}&` : ""}state=${archived ? "all" : "active"}${more && groupCursor ? `&cursor=${encodeURIComponent(groupCursor)}` : ""}`,
      );
      if (!current()) return;
      groups = more ? [...groups, ...result.groups] : result.groups;
      groupCursor = result.nextCursor;
      listLoaded = true;
    } catch (e) {
      if (current()) throw e;
    } finally {
      if (current()) listLoading = false;
    }
  }
  // Expose a group only together with cleared group-scoped state, so the detail
  // pane never shows another group's assignments or removal controls, nor offers
  // members or skills from an earlier view whose lookup has not been redone.
  // Starting a new detail generation discards responses for any earlier selection.
  function select(group: Group | null) {
    detailGeneration += 1;
    selected = group;
    targetMember = "";
    targetSkill = "";
    roster = [];
    available = [];
    name = group?.name ?? "";
    description = group?.description ?? "";
    skills = [];
    members = [];
    skillCursor = null;
    memberCursor = null;
  }
  // Settle every request before reporting the first failure, so the busy state is
  // released only after no response for this view is still outstanding.
  async function settleAll(work: Promise<unknown>[]) {
    const results = await Promise.allSettled(work);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) throw failure.reason;
  }
  async function loadDetail() {
    await settleAll([
      loadSkills(),
      loadMembers(),
      ...(canManage ? [loadRoster(), searchSkills()] : []),
    ]);
  }
  async function detail(group: Group) {
    if (!workspace) return;
    select(group);
    await loadDetail();
  }
  async function loadRoster() {
    if (!workspace || !selected) return;
    const t = token(workspace.id);
    const r = await apiRequest<{ members: Member[] }>(
      `/api/v1/workspaces/${encodeURIComponent(t.workspaceId)}/members`,
    );
    if (inDetail(t)) roster = r.members;
  }
  async function loadSkills(more = false) {
    if (!workspace || !selected) return;
    const t = token(workspace.id),
      groupId = selected.id;
    const q = new SvelteURLSearchParams({ limit: "20" });
    if (more && skillCursor) q.set("cursor", skillCursor);
    const r = await groupRequest<{
      skills: (Pick<Skill, "id" | "name" | "slug"> & { archivedAt: string | null })[];
      nextCursor: string | null;
    }>(t.workspaceId, `/${encodeURIComponent(groupId)}/skills?${q}`);
    if (!inDetail(t)) return;
    skills = more ? [...skills, ...r.skills] : r.skills;
    skillCursor = r.nextCursor;
  }
  async function loadMembers(more = false) {
    if (!workspace || !selected) return;
    const t = token(workspace.id),
      groupId = selected.id;
    const r = await groupRequest<{ members: Member[]; nextCursor: string | null }>(
      t.workspaceId,
      `/${encodeURIComponent(groupId)}/members${more && memberCursor ? `?cursor=${encodeURIComponent(memberCursor)}` : ""}`,
    );
    if (!inDetail(t)) return;
    members = more ? [...members, ...r.members] : r.members;
    memberCursor = r.nextCursor;
  }
  async function searchSkills() {
    if (!workspace || !selected) return;
    const t = token(workspace.id);
    const r = await apiRequest<{ skills: Skill[] }>(
      `/api/v1/workspaces/${encodeURIComponent(t.workspaceId)}/skills?${new SvelteURLSearchParams({ q: query, limit: "100" })}`,
    );
    if (!inDetail(t)) return;
    available = r.skills;
    targetSkill = "";
  }
  async function run(fn: () => Promise<void>) {
    if (busy || !workspace) return;
    const t = token(workspace.id);
    busy = true;
    error = "";
    await tracked(async () => {
      try {
        await fn();
      } catch (e) {
        if (inNavigation(t))
          error = e instanceof Error ? e.message : "The change failed";
      } finally {
        if (inNavigation(t)) busy = false;
      }
    });
  }
  async function save(archived = Boolean(selected?.archivedAt), lifecycleOnly = false) {
    if (!workspace) return;
    const t = token(workspace.id),
      creating = !selected,
      submitted = { name, description };
    const r = await groupRequest<{ group: Group }>(
      t.workspaceId,
      selected ? `/${encodeURIComponent(selected.id)}` : "",
      selected ? "PATCH" : "POST",
      lifecycleOnly && selected
        ? { expectedRevision: selected.revision, archived }
        : {
            name,
            description,
            ...(selected ? { expectedRevision: selected.revision, archived } : {}),
          },
      creating ? creationKey : undefined,
    );
    if (!inDetail(t)) return;
    // The response replaces a draft field only if it is still the submitted text;
    // an edit typed while the save was pending survives, and an archive or restore
    // keeps every draft.
    const draft = {
      name: !lifecycleOnly && name === submitted.name ? r.group.name : name,
      description:
        !lifecycleOnly && description === submitted.description
          ? r.group.description
          : description,
    };
    // Adopt the saved group before refreshing so a refresh failure leaves a retry
    // that PATCHes this revision instead of replaying a consumed creation key.
    if (creating) {
      creationKey = crypto.randomUUID();
      select(r.group);
      ({ name, description } = draft);
      await settleAll([load(), loadDetail()]);
      return;
    }
    selected = r.group;
    ({ name, description } = draft);
    await load();
  }
  async function assign(kind: "skills" | "members", id: string, add: boolean) {
    if (!workspace || !selected || !id) return;
    const t = token(workspace.id),
      group = selected;
    await groupRequest(
      t.workspaceId,
      `/${encodeURIComponent(group.id)}/${kind}/${encodeURIComponent(id)}`,
      add ? "PUT" : "DELETE",
    );
    if (!inDetail(t)) return;
    if (kind === "skills") targetSkill = "";
    else targetMember = "";
    // Refresh the assignment lists without reselecting, so an edit draft survives.
    // Member changes can move this group into or out of a member-filtered list.
    await settleAll([
      kind === "skills" ? loadSkills() : loadMembers(),
      ...(kind === "members" && page.url.searchParams.get("memberId") ? [load()] : []),
    ]);
  }
  $effect(() => {
    const key = workspace
      ? `${workspace.id}:${page.url.searchParams.get("memberId") ?? ""}`
      : "";
    if (!workspace || loaded === key) return;
    const workspaceId = workspace.id;
    // Reset and reload without subscribing this effect to the state it writes.
    untrack(() => {
      loaded = key;
      navigation += 1;
      select(null);
      groups = [];
      groupCursor = null;
      listLoaded = false;
      busy = false;
      error = "";
      creationKey = crypto.randomUUID();
      const t = token(workspaceId);
      void tracked(async () => {
        try {
          await load();
        } catch (e) {
          if (inNavigation(t))
            error = e instanceof Error ? e.message : "Groups could not be loaded";
        }
      });
    });
  });
</script>

<svelte:head
  ><title>Skill groups · {workspace?.name ?? "Skillplane"}</title></svelte:head
>
<main class="groups-page" data-pending-operations={pendingOperations}>
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
      disabled={busy}
      onchange={() => void run(() => load())}
    /> Include archived groups</label
  >
  {#if canManage}<Button
      variant="secondary"
      disabled={busy}
      onclick={() => {
        select(null);
        creationKey = crypto.randomUUID();
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
  {#if listLoaded && !listLoading && !error && !groups.length}<EmptyState
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
          onclick={() => void run(() => save(!selected?.archivedAt, true))}
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
              })}>{skill.name}{skill.archivedAt ? " (archived)" : ""}</a
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
                >Remove {m.displayName ?? m.email ?? m.userId}</Button
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
