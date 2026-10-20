<script lang="ts">
  import WorkspaceRequired from "$lib/layout/WorkspaceRequired.svelte";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
</script>

<WorkspaceRequired>{@render children()}</WorkspaceRequired>
