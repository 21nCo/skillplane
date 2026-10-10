<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button } from "@skillplane/ui";
  import { SafeMarkdown } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { getSkillFile } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    ArrowRightIcon,
    ClockCounterClockwiseIcon,
    FileTextIcon,
    ShieldCheckIcon,
  } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  let markdown = $state<string | null>(null);
  let markdownError = $state<string | null>(null);
  let loadingMarkdown = $state(true);
  let loadedVersionId = $state<string | null>(null);

  async function loadMarkdown() {
    if (!workspace || !detail.skill || !detail.currentVersion) return;
    loadingMarkdown = true;
    markdownError = null;
    try {
      const response = await getSkillFile({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: detail.currentVersion.id,
        path: "SKILL.md",
      });
      markdown = await response.text();
    } catch (cause) {
      markdownError =
        cause instanceof Error
          ? cause.message
          : "Skill instructions could not be loaded.";
    } finally {
      loadingMarkdown = false;
    }
  }

  $effect(() => {
    const versionId = detail.currentVersion?.id;
    if (versionId && versionId !== loadedVersionId) {
      loadedVersionId = versionId;
      void loadMarkdown();
    }
  });
</script>

<svelte:head>
  <title>{detail.skill?.name ?? "Skill"} · Skillplane</title>
</svelte:head>

{#if detail.skill && detail.currentVersion && workspace}
  <section class="overview-grid">
    <div class="main-column">
      <section class="panel">
        <div class="panel-heading">
          <div>
            <p class="label">Current instructions</p>
            <h2>SKILL.md</h2>
          </div>
          <Button
            size="sm"
            variant="secondary"
            href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/content", {
              workspaceSlug: workspace.slug,
              skillSlug: detail.skill.slug,
            })}
          >
            Browse content
            {#snippet trailing()}<ArrowRightIcon weight="bold" />{/snippet}
          </Button>
        </div>
        {#if loadingMarkdown}
          <SkillState
            kind="loading"
            title="Loading instructions"
            message="Verifying the immutable file digest."
          />
        {:else if markdownError}
          <SkillState
            kind="error"
            title="Instructions could not be loaded"
            message={markdownError}
            retry={() => void loadMarkdown()}
          />
        {:else if markdown}
          <div class="markdown-preview"><SafeMarkdown source={markdown} /></div>
        {/if}
      </section>
    </div>

    <aside>
      <section class="panel facts">
        <p class="label">Current release</p>
        <dl>
          <div>
            <dt>Semantic version</dt>
            <dd>v{detail.currentVersion.semanticVersion}</dd>
          </div>
          <div>
            <dt>Revision</dt>
            <dd>{detail.currentVersion.revision}</dd>
          </div>
          <div>
            <dt>Bundle digest</dt>
            <dd title={detail.currentVersion.digest}>
              {detail.currentVersion.digest.slice(0, 19)}…
            </dd>
          </div>
          <div>
            <dt>Files</dt>
            <dd>{detail.currentVersion.manifest.fileCount}</dd>
          </div>
          <div>
            <dt>Bundle size</dt>
            <dd>{(detail.currentVersion.byteSize / 1024).toFixed(1)} KiB</dd>
          </div>
        </dl>
      </section>

      <section class="panel links">
        <p class="label">Operate</p>
        <a
          href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/content", {
            workspaceSlug: workspace.slug,
            skillSlug: detail.skill.slug,
          })}
        >
          <FileTextIcon weight="duotone" aria-hidden="true" />
          <span><strong>Content</strong><small>Inspect verified files</small></span>
        </a>
        <a
          href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/versions", {
            workspaceSlug: workspace.slug,
            skillSlug: detail.skill.slug,
          })}
        >
          <ClockCounterClockwiseIcon weight="duotone" aria-hidden="true" />
          <span><strong>Versions</strong><small>Compare immutable history</small></span>
        </a>
        <a
          href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/settings", {
            workspaceSlug: workspace.slug,
            skillSlug: detail.skill.slug,
          })}
        >
          <ShieldCheckIcon weight="duotone" aria-hidden="true" />
          <span><strong>Settings</strong><small>Visibility and lifecycle</small></span>
        </a>
      </section>

      <section class="panel">
        <p class="label">Tags</p>
        <div class="tags">
          {#each detail.skill.tags as tag (tag)}
            <Badge tone="neutral">{tag}</Badge>
          {:else}
            <span class="muted">No discovery tags</span>
          {/each}
        </div>
      </section>
    </aside>
  </section>
{/if}

<style>
  .overview-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) 19rem;
    gap: var(--sp-space-4);
    align-items: start;
  }

  .main-column,
  aside {
    display: grid;
    gap: var(--sp-space-4);
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
    padding-bottom: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .label,
  h2 {
    margin: 0;
  }

  .label {
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

  .markdown-preview {
    max-height: 42rem;
    overflow: auto;
    padding: var(--sp-space-4) 0 0;
  }

  dl {
    display: grid;
    gap: var(--sp-space-3);
    margin: var(--sp-space-3) 0 0;
  }

  dl div {
    display: grid;
    gap: var(--sp-space-1);
  }

  dt {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  dd {
    overflow: hidden;
    margin: 0;
    color: var(--sp-color-text);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
    text-overflow: ellipsis;
  }

  .links {
    display: grid;
    gap: var(--sp-space-1);
  }

  .links .label {
    margin-bottom: var(--sp-space-2);
  }

  .links a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-2);
    align-items: center;
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    text-decoration: none;
  }

  .links a:hover {
    background: var(--sp-color-surface-hover);
    color: var(--sp-color-text);
  }

  .links strong,
  .links small {
    display: block;
  }

  .links strong {
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-3);
  }

  .links small {
    margin-top: 2px;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-1);
    margin-top: var(--sp-space-3);
  }

  .muted {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-3);
  }

  @media (max-width: 60rem) {
    .overview-grid {
      grid-template-columns: 1fr;
    }

    aside {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 36rem) {
    aside {
      grid-template-columns: 1fr;
    }
  }
</style>
