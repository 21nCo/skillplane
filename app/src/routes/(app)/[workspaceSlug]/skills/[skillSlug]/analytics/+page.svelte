<script lang="ts">
  import { page } from "$app/state";
  import AnalyticsDashboard from "$lib/analytics/AnalyticsDashboard.svelte";
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
  <AnalyticsDashboard
    embedded
    workspaceId={workspace.id}
    skillId={detail.skill.id}
    title="Skill analytics"
    description="Usage, adoption, latency, and caller-declared agent dimensions for this skill."
  />
{/if}
