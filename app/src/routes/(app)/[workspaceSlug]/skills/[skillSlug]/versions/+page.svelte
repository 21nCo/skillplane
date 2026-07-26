<script lang="ts">
  import { page } from "$app/state";
  import { Button, Select } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import VersionDiff from "$lib/skills/VersionDiff.svelte";
  import VersionTimeline from "$lib/skills/VersionTimeline.svelte";
  import { getSkillDiff } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type { SkillVersionDiff } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowsLeftRightIcon } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );

  let fromVersionId = $state("");
  let toVersionId = $state("");
  let diff = $state<SkillVersionDiff | null>(null);
  let loadingDiff = $state(false);
  let diffError = $state<string | null>(null);
  let initialized = $state(false);

  $effect(() => {
    if (!initialized && detail.versions.length > 0) {
      const current = detail.currentVersion ?? detail.versions[0];
      const previous =
        detail.versions.find((version) => version.id === current.baseVersionId) ??
        detail.versions.find((version) => version.id !== current.id);
      toVersionId = current.id;
      fromVersionId = previous?.id ?? "";
      initialized = true;
    }
  });

  async function compare(event: SubmitEvent) {
    event.preventDefault();
    if (!workspace || !detail.skill || !fromVersionId || !toVersionId) return;
    loadingDiff = true;
    diffError = null;
    try {
      diff = await getSkillDiff({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        fromVersionId,
        toVersionId,
      });
    } catch (cause) {
      diffError =
        cause instanceof Error ? cause.message : "Versions could not be compared.";
    } finally {
      loadingDiff = false;
    }
  }

  function versionLabel(versionId: string): string {
    const version = detail.versions.find((entry) => entry.id === versionId);
    if (!version) return "revision unknown";
    return version.semanticVersion
      ? `v${version.semanticVersion}`
      : `revision ${String(version.revision)}`;
  }
</script>

<svelte:head>
  <title>Versions · {detail.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if detail.skill && workspace}
  <div class="versions-grid">
    <section class="panel history">
      <header>
        <div>
          <p>Immutable history</p>
          <h2>{detail.versions.length} versions</h2>
        </div>
      </header>
      {#if detail.versions.length > 0}
        <VersionTimeline
          versions={detail.versions}
          workspaceSlug={workspace.slug}
          skillSlug={detail.skill.slug}
        />
      {:else}
        <SkillState
          kind="empty"
          title="No versions"
          message="This skill has no visible versions."
        />
      {/if}
    </section>

    <section class="panel compare">
      <header>
        <div>
          <p>Compare</p>
          <h2>Version diff</h2>
        </div>
      </header>
      {#if detail.versions.length < 2}
        <SkillState
          kind="empty"
          title="One version published"
          message="Create a candidate revision before comparing immutable versions."
        />
      {:else}
        <form onsubmit={compare}>
          <Select
            label="From"
            options={detail.versions.map((version) => ({
              value: version.id,
              label: version.semanticVersion
                ? `v${version.semanticVersion} · revision ${String(version.revision)}`
                : `Revision ${String(version.revision)} · ${version.status.replace("_", " ")}`,
            }))}
            bind:value={fromVersionId}
          />
          <span class="arrow" aria-hidden="true">
            <ArrowsLeftRightIcon weight="bold" />
          </span>
          <Select
            label="To"
            options={detail.versions.map((version) => ({
              value: version.id,
              label: version.semanticVersion
                ? `v${version.semanticVersion} · revision ${String(version.revision)}`
                : `Revision ${String(version.revision)} · ${version.status.replace("_", " ")}`,
            }))}
            bind:value={toVersionId}
          />
          <Button
            type="submit"
            loading={loadingDiff}
            disabled={!fromVersionId || !toVersionId || fromVersionId === toVersionId}
          >
            Compare versions
          </Button>
        </form>

        {#if diffError}
          <SkillState
            kind="error"
            title="Diff could not be loaded"
            message={diffError}
            retry={() => {
              const synthetic = new SubmitEvent("submit");
              void compare(synthetic);
            }}
          />
        {:else if diff}
          <div class="diff-heading">
            {versionLabel(diff.fromVersionId)} → {versionLabel(diff.toVersionId)}
          </div>
          <VersionDiff files={diff.files} />
        {/if}
      {/if}
    </section>
  </div>
{/if}

<style>
  .versions-grid {
    display: grid;
    gap: var(--sp-space-4);
  }

  .panel {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface);
  }

  .panel > header {
    margin-bottom: var(--sp-space-4);
    padding-bottom: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  header p,
  h2 {
    margin: 0;
  }

  header p {
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

  form {
    display: grid;
    grid-template-columns: minmax(13rem, 1fr) auto minmax(13rem, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: end;
    margin-bottom: var(--sp-space-4);
  }

  .arrow {
    display: grid;
    height: var(--sp-control-height);
    place-items: center;
    color: var(--sp-color-text-subtle);
  }

  .diff-heading {
    margin: var(--sp-space-4) 0 var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
  }

  @media (max-width: 56rem) {
    form {
      grid-template-columns: 1fr 1fr;
    }

    .arrow {
      display: none;
    }
  }

  @media (max-width: 36rem) {
    form {
      grid-template-columns: 1fr;
    }
  }
</style>
