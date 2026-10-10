<script lang="ts">
  import { page } from "$app/state";
  import AnalyticsDashboard from "$lib/analytics/AnalyticsDashboard.svelte";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";

  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
</script>

{#if workspace}
  <AnalyticsDashboard
    workspaceId={workspace.id}
    title="Workspace analytics"
    description="Retrieval adoption, declared agent usage, failures, and latency from permanent UTC rollups."
  />
{/if}
