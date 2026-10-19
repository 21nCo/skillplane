<script lang="ts">
  import { page } from "$app/state";
  import { Button, Select } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import VersionDiff from "$lib/skills/VersionDiff.svelte";
  import VersionTimeline from "$lib/skills/VersionTimeline.svelte";
  import {
    VersionComparison,
    defaultComparison,
  } from "$lib/skills/version-comparison.svelte.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowsLeftRightIcon } from "phosphor-svelte";

  let {
    versionHref,
  }: {
    /** Overrides the skill version route, for example for instructions. */
    versionHref?: (versionId: string) => string;
  } = $props();

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );

  let fromVersionId = $state("");
  let toVersionId = $state("");
  let initializedFor = $state<string | null>(null);
  const comparison = new VersionComparison();

  // Another artifact gets its own default selection and drops the previous result.
  $effect(() => {
    const skillId = detail.skill?.id ?? null;
    if (!skillId || initializedFor === skillId || detail.versions.length === 0) return;
    const selection = defaultComparison(detail.versions, detail.currentVersion);
    fromVersionId = selection?.fromVersionId ?? "";
    toVersionId = selection?.toVersionId ?? "";
    comparison.reset();
    initializedFor = skillId;
  });

  function compare(event: SubmitEvent) {
    event.preventDefault();
    if (!workspace || !detail.skill || !fromVersionId || !toVersionId) return;
    void comparison.compare({
      workspaceId: workspace.id,
      skillId: detail.skill.id,
      fromVersionId,
      toVersionId,
    });
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
          {versionHref}
        />
      {:else}
        <SkillState kind="empty" title="No versions" message="No visible versions." />
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
          title={detail.versions.length === 0
            ? "No versions to compare"
            : "One version published"}
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
            loading={comparison.loading}
            disabled={!fromVersionId || !toVersionId || fromVersionId === toVersionId}
          >
            Compare versions
          </Button>
        </form>

        {#if comparison.error}
          <SkillState
            kind="error"
            title="Diff could not be loaded"
            message={comparison.error}
            retry={() => {
              compare(new SubmitEvent("submit"));
            }}
          />
        {:else if comparison.diff}
          <div class="diff-heading">
            {versionLabel(comparison.diff.fromVersionId)} →
            {versionLabel(comparison.diff.toVersionId)}
          </div>
          <VersionDiff files={comparison.diff.files} />
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
