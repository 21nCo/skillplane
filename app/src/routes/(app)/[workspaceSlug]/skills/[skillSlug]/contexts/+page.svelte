<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import ContextEditor from "$lib/contexts/ContextEditor.svelte";
  import { listContexts } from "$lib/contexts/api.js";
  import type {
    ContextArchiveFilter,
    ContextCreateResult,
    SkillContext,
  } from "$lib/contexts/types.js";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { Badge, Button, Select } from "@skillplane/ui";
  import {
    ArchiveIcon,
    ArrowRightIcon,
    FolderOpenIcon,
    PlusIcon,
  } from "phosphor-svelte";
  import { tick } from "svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(
    Boolean(workspace && workspace.role !== "viewer" && !detail.skill?.archivedAt),
  );

  let contexts = $state<readonly SkillContext[]>([]);
  let archive = $state<ContextArchiveFilter>("active");
  let creating = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadedSkillId = $state<string | null>(null);

  async function load() {
    if (!workspace || !detail.skill) return;
    loading = true;
    error = null;
    try {
      contexts = await listContexts({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        archive,
      });
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Contexts could not be loaded.";
    } finally {
      loading = false;
    }
  }

  function contextCreated(result: ContextCreateResult) {
    if (!workspace || !detail.skill) return;
    const href = resolve(
      "/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]",
      {
        workspaceSlug: workspace.slug,
        skillSlug: detail.skill.slug,
        contextSlug: result.context.slug,
      },
    );
    /* eslint-disable svelte/no-navigation-without-resolve */
    void goto(`${href}?created=true`);
    /* eslint-enable svelte/no-navigation-without-resolve */
  }

  function closeCreator() {
    creating = false;
    void tick().then(() => {
      document.querySelector<HTMLElement>("#new-context-trigger")?.focus();
    });
  }

  $effect(() => {
    if (detail.skill && loadedSkillId !== detail.skill.id) {
      loadedSkillId = detail.skill.id;
      void load();
    }
  });

  function typeTone(type: SkillContext["type"]) {
    if (type === "repository") return "info" as const;
    if (type === "customer") return "warning" as const;
    return "neutral" as const;
  }
</script>

<svelte:head>
  <title>Contexts · {detail.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if detail.skill && workspace}
  <section class="context-workspace">
    <header class="page-heading">
      <div>
        <p class="eyebrow">Scoped knowledge</p>
        <h2>Contexts</h2>
        <p>
          Keep project, repository, customer, and environment learnings attached to this
          skill without changing its portable instructions.
        </p>
      </div>
      {#if canWrite}
        <Button id="new-context-trigger" onclick={() => (creating = !creating)}>
          {#snippet leading()}<PlusIcon weight="bold" />{/snippet}
          {creating ? "Close creator" : "New context"}
        </Button>
      {/if}
    </header>

    {#if workspace.role === "viewer"}
      <p class="role-note">
        Your viewer role can inspect context knowledge and immutable revision history.
        Editing controls are hidden.
      </p>
    {/if}

    {#if creating && canWrite}
      <section class="creator" aria-label="Create context">
        <ContextEditor
          workspaceId={workspace.id}
          skillId={detail.skill.id}
          onCreated={contextCreated}
          onCancel={closeCreator}
        />
      </section>
    {/if}

    <div class="toolbar">
      <Select
        label="Lifecycle state"
        options={[
          { value: "active", label: "Active contexts" },
          { value: "archived", label: "Archived contexts" },
          { value: "all", label: "Active and archived" },
        ]}
        bind:value={archive}
        onchange={() => void load()}
      />
      <p>{contexts.length} visible {contexts.length === 1 ? "context" : "contexts"}</p>
    </div>

    {#if loading}
      <SkillState
        kind="loading"
        title="Loading contexts"
        message="Loading scoped knowledge for this skill."
      />
    {:else if error}
      <SkillState
        kind="error"
        title="Contexts could not be loaded"
        message={error}
        retry={() => void load()}
      />
    {:else if contexts.length === 0}
      <SkillState
        kind="empty"
        title={archive === "active"
          ? "No active contexts"
          : archive === "archived"
            ? "No archived contexts"
            : "No contexts yet"}
        message={canWrite
          ? "Create a context to retain durable knowledge for one project or environment."
          : "An editor can create scoped context knowledge for this skill."}
      >
        {#if canWrite && !creating}
          <Button onclick={() => (creating = true)}>Create context</Button>
        {/if}
      </SkillState>
    {:else}
      <div class="inventory">
        {#each contexts as context (context.id)}
          <article class:archived={Boolean(context.archivedAt)}>
            <a
              href={resolve(
                "/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]",
                {
                  workspaceSlug: workspace.slug,
                  skillSlug: detail.skill.slug,
                  contextSlug: context.slug,
                },
              )}
            >
              <span class="context-mark" aria-hidden="true">
                {#if context.archivedAt}
                  <ArchiveIcon weight="duotone" />
                {:else}
                  <FolderOpenIcon weight="duotone" />
                {/if}
              </span>
              <span class="context-copy">
                <span class="title-row">
                  <strong>{context.name}</strong>
                  <Badge tone={typeTone(context.type)}>{context.type}</Badge>
                  {#if context.archivedAt}<Badge tone="warning">Archived</Badge>{/if}
                </span>
                <span class="description">
                  {context.description || "No description provided."}
                </span>
                <span class="meta">
                  <code>{context.slug}</code>
                  <span>
                    Knowledge revision {context.currentKnowledgeRevision ?? "—"}
                  </span>
                  {#if context.externalReference}
                    <span>{context.externalReference}</span>
                  {/if}
                </span>
              </span>
              <span class="arrow" aria-hidden="true">
                <ArrowRightIcon weight="bold" />
              </span>
            </a>
          </article>
        {/each}
      </div>
    {/if}
  </section>
{/if}

<style>
  .context-workspace {
    display: grid;
    gap: var(--sp-space-5);
  }

  .page-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-space-6);
  }

  .eyebrow,
  h2,
  p {
    margin: 0;
  }

  .eyebrow {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.07em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-6);
    letter-spacing: -0.025em;
  }

  .page-heading > div > p:last-child {
    max-width: 48rem;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
  }

  .role-note,
  .creator,
  .toolbar,
  article {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  .role-note {
    padding: var(--sp-space-3) var(--sp-space-4);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .creator {
    padding: var(--sp-space-5);
  }

  .toolbar {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: var(--sp-space-4);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-muted);
  }

  .toolbar > :global(div),
  .toolbar > :global(label) {
    max-width: 17rem;
  }

  .toolbar p {
    padding-bottom: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .inventory {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3);
  }

  article {
    overflow: hidden;
  }

  article.archived {
    opacity: 0.78;
  }

  article a {
    display: grid;
    min-height: 10.5rem;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: start;
    padding: var(--sp-space-4);
    color: inherit;
    text-decoration: none;
  }

  article a:hover {
    background: var(--sp-color-surface-hover);
  }

  .context-mark {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .context-copy,
  .title-row,
  .meta {
    display: flex;
    min-width: 0;
  }

  .context-copy {
    flex-direction: column;
    gap: var(--sp-space-2);
  }

  .title-row,
  .meta {
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-space-2);
  }

  .description,
  .meta {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .meta {
    margin-top: auto;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .arrow {
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
  }

  @media (max-width: 52rem) {
    .inventory {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 38rem) {
    .page-heading,
    .toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .creator {
      padding: var(--sp-space-4);
    }
  }
</style>
