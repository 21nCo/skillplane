<script lang="ts">
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { resolve } from "$app/paths";
  import { Button } from "@skillplane/ui";
  import { WarningCircleIcon } from "phosphor-svelte";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  let {
    data,
    children,
  }: {
    data: LayoutData;
    children: Snippet;
  } = $props();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find((candidate) => candidate.slug === data.workspaceSlug) ??
      null,
  );

  $effect(() => {
    if (workspace && workspaces.activeId !== workspace.id) {
      workspaces.select(workspace.id);
    }
  });
</script>

{#if workspace}
  {@render children()}
{:else}
  <main class="missing">
    <WarningCircleIcon weight="duotone" aria-hidden="true" />
    <h1>Workspace not available</h1>
    <p>This workspace does not exist or your current account no longer has access.</p>
    <Button href={resolve("/workspaces")} variant="secondary">
      Choose a workspace
    </Button>
  </main>
{/if}

<style>
  .missing {
    display: grid;
    min-height: calc(100dvh - var(--sp-topbar-height));
    place-items: center;
    align-content: center;
    gap: var(--sp-space-3);
    padding: var(--sp-space-6);
    text-align: center;
  }

  .missing > :global(svg) {
    color: var(--sp-color-danger);
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: var(--sp-font-size-6);
  }

  p {
    max-width: 32rem;
    color: var(--sp-color-text-muted);
  }
</style>
