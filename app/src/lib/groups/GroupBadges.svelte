<script lang="ts">
  import { resolve } from "$app/paths";
  import { groupRequest, type Group } from "./api.js";
  let {
    workspaceId,
    skillId,
    userId,
    workspaceSlug,
  }: { workspaceId: string; skillId?: string; userId?: string; workspaceSlug: string } =
    $props();
  let groups = $state<Group[]>([]),
    error = $state("");
  let generation = 0;
  $effect(() => {
    const w = workspaceId,
      s = skillId,
      u = userId;
    const request = ++generation;
    error = "";
    groups = [];
    void (async () => {
      try {
        let cursor: string | null = null;
        const all: Group[] = [];
        do {
          const q: URLSearchParams = new URLSearchParams({
            ...(s ? { skillId: s } : {}),
            ...(u ? { userId: u } : {}),
            ...(cursor ? { cursor } : {}),
          });
          const r: { groups: Group[]; nextCursor: string | null } = await groupRequest<{
            groups: Group[];
            nextCursor: string | null;
          }>(w, `?${q}`);
          all.push(...r.groups);
          cursor = r.nextCursor;
        } while (cursor);
        if (request === generation) groups = all;
      } catch {
        if (request === generation) error = "Groups could not be loaded";
      }
    })();
    return () => {
      generation++;
    };
  });
</script>

{#if groups.length}<span aria-label="Skill groups"
    >{#each groups as group (group.id)}<a
        href={resolve("/(app)/[workspaceSlug]/groups", { workspaceSlug })}
        >{group.name}</a
      >{/each}</span
  >{/if}{#if error}<span role="status">{error}</span>{/if}

<style>
  span a {
    margin-right: 0.5rem;
  }
</style>
