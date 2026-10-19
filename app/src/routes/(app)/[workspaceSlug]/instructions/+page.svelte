<script lang="ts">
  import { untrack } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button, Input, Select } from "@skillplane/ui";
  import KindBadge from "$lib/skills/KindBadge.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { listSkills } from "$lib/skills/api.js";
  import type { Skill, SkillArchiveFilter } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    ArchiveIcon,
    MagnifyingGlassIcon,
    PlusIcon,
    ScrollIcon,
  } from "phosphor-svelte";

  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(Boolean(workspace && workspace.role !== "viewer"));

  let documents = $state<Skill[]>([]);
  let query = $state("");
  let archive = $state<SkillArchiveFilter>("active");
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let loadedWorkspaceId = $state<string | null>(null);
  // The filters the listed page was loaded with; a cursor is valid only for them.
  let loadedFilters = $state<{ query: string; archive: SkillArchiveFilter }>({
    query: "",
    archive: "active",
  });
  let generation = 0;

  // Only the latest request may update the list; a slower superseded one is dropped.
  // Loading more keeps the loaded filters even when the search field was edited.
  async function load(reset = true) {
    if (!workspace) return;
    const current = ++generation;
    const filters = reset ? { query, archive } : loadedFilters;
    if (reset) loading = true;
    else loadingMore = true;
    error = null;
    try {
      const result = await listSkills({
        workspaceId: workspace.id,
        kind: "instructions",
        query: filters.query,
        archive: filters.archive,
        cursor: reset ? null : nextCursor,
        limit: 20,
      });
      if (current !== generation) return;
      loadedFilters = filters;
      documents = reset ? [...result.skills] : [...documents, ...result.skills];
      nextCursor = result.nextCursor;
    } catch (cause) {
      if (current !== generation) return;
      error =
        cause instanceof Error ? cause.message : "Instructions could not be loaded.";
    } finally {
      if (current === generation) {
        loading = false;
        loadingMore = false;
      }
    }
  }

  $effect(() => {
    if (workspace && loadedWorkspaceId !== workspace.id) {
      loadedWorkspaceId = workspace.id;
      untrack(() => void load());
    }
  });

  const filtered = $derived(
    Boolean(loadedFilters.query || loadedFilters.archive !== "active"),
  );
</script>

<svelte:head>
  <title>Instructions · {workspace?.name ?? "Skillplane"}</title>
</svelte:head>

<main class="list-page">
  <header class="page-heading">
    <div>
      <p class="eyebrow">Knowledge plane</p>
      <h1>Instructions</h1>
      <p>
        Versioned AGENTS.md documents, reviewed and published like skills but never
        resolved as one.
      </p>
    </div>
    {#if workspace && canWrite}
      <Button
        href={resolve("/(app)/[workspaceSlug]/instructions/-/new", {
          workspaceSlug: workspace.slug,
        })}
      >
        {#snippet leading()}<PlusIcon weight="bold" />{/snippet}
        New instructions
      </Button>
    {/if}
  </header>

  <section class="filters" aria-label="Instructions filters">
    <form
      onsubmit={(event) => {
        event.preventDefault();
        void load();
      }}
    >
      <Input
        label="Search instructions"
        hideLabel
        placeholder="Search names, tags, and published documents"
        bind:value={query}
      />
      <Button type="submit" variant="secondary">
        {#snippet leading()}<MagnifyingGlassIcon weight="bold" />{/snippet}
        Search
      </Button>
    </form>
    <Select
      label="Lifecycle state"
      options={[
        { value: "active", label: "Active" },
        { value: "archived", label: "Archived" },
        { value: "all", label: "Active and archived" },
      ]}
      bind:value={archive}
      onchange={() => void load()}
    />
  </section>

  {#if loading}
    <SkillState
      kind="loading"
      title="Loading instructions"
      message="Loading the authorized instructions documents."
    />
  {:else if error}
    <SkillState
      kind="error"
      title="Instructions could not be loaded"
      message={error}
      retry={() => void load()}
    />
  {:else if documents.length === 0}
    <SkillState
      kind="empty"
      title={filtered
        ? "No instructions match these filters"
        : "Create your first instructions"}
      message={filtered
        ? "Change the search or filters and try again."
        : canWrite
          ? "Author an AGENTS.md document with the Markdown editor."
          : "Your viewer role can inspect instructions after an editor publishes one."}
    />
  {:else}
    <section class="inventory" aria-label="Instructions inventory">
      {#each documents as document (document.id)}
        <article class:archived={Boolean(document.archivedAt)}>
          <a
            href={resolve("/(app)/[workspaceSlug]/instructions/[instructionsSlug]", {
              workspaceSlug: workspace?.slug ?? page.params.workspaceSlug ?? "",
              instructionsSlug: document.slug,
            })}
          >
            <span class="icon" aria-hidden="true">
              {#if document.archivedAt}
                <ArchiveIcon weight="duotone" />
              {:else}
                <ScrollIcon weight="duotone" />
              {/if}
            </span>
            <span class="copy">
              <span class="title-row">
                <strong>{document.name}</strong>
                <KindBadge kind={document.kind} />
                <Badge tone={document.visibility === "workspace" ? "info" : "neutral"}>
                  {document.visibility}
                </Badge>
                {#if document.archivedAt}<Badge tone="warning">Archived</Badge>{/if}
              </span>
              <span class="description">
                {document.description || "No description provided."}
              </span>
              <span class="meta">
                <code>{document.slug}</code>
                <span>v{document.currentSemanticVersion ?? "unpublished"}</span>
              </span>
            </span>
          </a>
        </article>
      {/each}
    </section>
    {#if nextCursor}
      <div class="pagination">
        <Button
          variant="secondary"
          loading={loadingMore}
          disabled={loadingMore}
          onclick={() => void load(false)}
        >
          Load more instructions
        </Button>
      </div>
    {/if}
  {/if}
</main>

<style>
  .list-page {
    width: min(100%, 78rem);
    margin: 0 auto;
    padding: var(--sp-space-8) var(--sp-space-6) var(--sp-space-16);
  }

  .page-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-space-6);
  }

  .eyebrow {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-7);
    letter-spacing: -0.035em;
  }

  .page-heading p:last-child {
    max-width: 46rem;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
  }

  .filters {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(12rem, 16rem);
    gap: var(--sp-space-3);
    align-items: end;
    margin: var(--sp-space-6) 0 var(--sp-space-4);
  }

  form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-space-2);
  }

  .inventory {
    display: grid;
    gap: var(--sp-space-2);
  }

  article {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  article:hover {
    border-color: var(--sp-color-border-strong);
    background: var(--sp-color-surface-hover);
  }

  article.archived {
    opacity: 0.78;
  }

  article a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-3);
    padding: var(--sp-space-4);
    color: inherit;
    text-decoration: none;
  }

  .icon {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-info-soft);
    color: var(--sp-color-info);
  }

  .copy {
    min-width: 0;
  }

  .title-row,
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
  }

  .description {
    display: block;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .meta {
    margin-top: var(--sp-space-3);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  code {
    font-family: var(--sp-font-mono);
  }

  .pagination {
    display: flex;
    justify-content: center;
    padding: var(--sp-space-5);
  }

  @media (max-width: 52rem) {
    .list-page {
      padding: var(--sp-space-5) var(--sp-space-3) var(--sp-space-12);
    }

    .page-heading,
    .filters {
      display: grid;
      grid-template-columns: 1fr;
    }
  }
</style>
