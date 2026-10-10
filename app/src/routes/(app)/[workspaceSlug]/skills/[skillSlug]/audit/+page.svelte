<script lang="ts">
  import { page } from "$app/state";
  import AuditExplorer from "$lib/audit/AuditExplorer.svelte";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
</script>

{#if workspace && detail.skill}
  <AuditExplorer
    embedded
    workspaceId={workspace.id}
    skillId={detail.skill.id}
    title="Skill audit"
    description="Redacted retrieval and mutation history for this skill."
  />
{/if}
