<script lang="ts">
  import AppShell from "$lib/layout/AppShell.svelte";
  import { provideWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  let {
    data,
    children,
  }: {
    data: LayoutData;
    children: Snippet;
  } = $props();
  const workspaces = provideWorkspaceStore();
</script>

<AppShell session={data.session} {workspaces}>{@render children()}</AppShell>
