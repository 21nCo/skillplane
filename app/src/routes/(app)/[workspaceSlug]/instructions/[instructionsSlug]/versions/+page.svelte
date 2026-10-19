<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import VersionHistory from "$lib/skills/VersionHistory.svelte";
</script>

<VersionHistory
  versionHref={(versionId) =>
    resolve(
      "/(app)/[workspaceSlug]/instructions/[instructionsSlug]/versions/[versionId]",
      {
        workspaceSlug: page.params.workspaceSlug ?? "",
        instructionsSlug: page.params.instructionsSlug ?? "",
        versionId,
      },
    )}
/>
