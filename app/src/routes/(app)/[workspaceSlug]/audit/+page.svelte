<script lang="ts">
  import { page } from "$app/state";
  import AuditExplorer from "$lib/audit/AuditExplorer.svelte";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";

  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
</script>

{#if workspace}
  <AuditExplorer
    workspaceId={workspace.id}
    title="Workspace audit"
    description="Redacted security and usage history with authenticated principals separated from caller-declared metadata."
  />
{/if}
