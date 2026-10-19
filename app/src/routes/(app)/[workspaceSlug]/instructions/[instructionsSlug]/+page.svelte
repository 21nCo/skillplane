<script lang="ts">
  import { page } from "$app/state";
  import { SafeMarkdown } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { getInstructionsDocument } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  let markdown = $state<string | null>(null);
  let error = $state<string | null>(null);
  let loading = $state(true);
  let loadedVersionId = $state<string | null>(null);
  let request = 0;

  // Only the latest load owns the document; a superseded version's response is dropped.
  async function load() {
    if (!workspace || !detail.skill || !detail.currentVersion) return;
    const current = ++request;
    loading = true;
    error = null;
    try {
      const document = await getInstructionsDocument({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: detail.currentVersion.id,
      });
      if (current === request) markdown = document;
    } catch (cause) {
      if (current === request) {
        error =
          cause instanceof Error ? cause.message : "AGENTS.md could not be loaded.";
      }
    } finally {
      if (current === request) loading = false;
    }
  }

  $effect(() => {
    const versionId = detail.currentVersion?.id;
    if (versionId && versionId !== loadedVersionId) {
      loadedVersionId = versionId;
      void load();
    }
  });
</script>

<svelte:head>
  <title>{detail.skill?.name ?? "Instructions"} · Skillplane</title>
</svelte:head>

{#if detail.currentVersion}
  <section class="panel">
    <header>
      <div>
        <p>Published document · v{detail.currentVersion.semanticVersion}</p>
        <h2>AGENTS.md</h2>
      </div>
      <code title={detail.currentVersion.digest}
        >{detail.currentVersion.digest.slice(0, 19)}…</code
      >
    </header>
    {#if loading}
      <SkillState
        kind="loading"
        title="Loading AGENTS.md"
        message="Verifying the immutable file digest."
      />
    {:else if error}
      <SkillState
        kind="error"
        title="AGENTS.md could not be loaded"
        message={error}
        retry={() => void load()}
      />
    {:else if markdown}
      <div class="markdown-preview"><SafeMarkdown source={markdown} /></div>
    {/if}
  </section>
{/if}

<style>
  .panel {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface);
  }

  header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
    padding-bottom: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  p,
  h2 {
    margin: 0;
  }

  p {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }

  code {
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
  }

  .markdown-preview {
    max-height: 42rem;
    overflow: auto;
    padding-top: var(--sp-space-4);
  }
</style>
