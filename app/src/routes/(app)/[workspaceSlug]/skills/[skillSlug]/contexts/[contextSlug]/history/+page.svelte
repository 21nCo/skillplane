<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import RevisionHistory from "$lib/contexts/RevisionHistory.svelte";
  import {
    getContextBySlug,
    listContextNotes,
    listKnowledgeHistory,
    listNoteHistory,
  } from "$lib/contexts/api.js";
  import type {
    ContextKnowledgeRevision,
    ContextNote,
    ContextNoteRevision,
    SkillContext,
  } from "$lib/contexts/types.js";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { Badge, Select } from "@skillplane/ui";
  import { ArrowLeftIcon, ClockCounterClockwiseIcon } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );

  let context = $state<SkillContext | null>(null);
  let notes = $state<readonly ContextNote[]>([]);
  let knowledgeRevisions = $state<readonly ContextKnowledgeRevision[]>([]);
  let noteRevisions = $state<readonly ContextNoteRevision[]>([]);
  let selected = $state("knowledge");
  let loading = $state(true);
  let loadingRevisions = $state(false);
  let error = $state<string | null>(null);
  let loadKey = $state("");

  async function load() {
    if (!workspace || !detail.skill) return;
    loading = true;
    error = null;
    try {
      context = await getContextBySlug({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        contextSlug: page.params.contextSlug ?? "",
      });
      [knowledgeRevisions, notes] = await Promise.all([
        listKnowledgeHistory(workspace.id, context.id),
        listContextNotes({
          workspaceId: workspace.id,
          contextId: context.id,
          archive: "all",
        }),
      ]);
      const requestedNote = page.url.searchParams.get("note");
      selected =
        requestedNote && notes.some((note) => note.id === requestedNote)
          ? requestedNote
          : "knowledge";
      if (selected !== "knowledge") {
        noteRevisions = await listNoteHistory(workspace.id, selected);
      }
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Revision history could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function selectionChanged() {
    if (!workspace || selected === "knowledge") {
      noteRevisions = [];
      return;
    }
    loadingRevisions = true;
    error = null;
    try {
      noteRevisions = await listNoteHistory(workspace.id, selected);
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Note history could not be loaded.";
    } finally {
      loadingRevisions = false;
    }
  }

  $effect(() => {
    const key =
      workspace && detail.skill
        ? `${workspace.id}:${detail.skill.id}:${page.params.contextSlug ?? ""}`
        : "";
    if (key && loadKey !== key) {
      loadKey = key;
      void load();
    }
  });
</script>

<svelte:head>
  <title>Revision history · {context?.name ?? "Context"} · Skillplane</title>
</svelte:head>

{#if loading}
  <SkillState
    kind="loading"
    title="Loading immutable history"
    message="Loading context knowledge and note revisions."
  />
{:else if error !== null || !context || !workspace || !detail.skill}
  <SkillState
    kind="error"
    title="Revision history could not be loaded"
    message={error ?? "The context does not exist or access was removed."}
    retry={() => void load()}
  />
{:else}
  <div class="history-page">
    <a
      class="back"
      href={resolve(
        "/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]",
        {
          workspaceSlug: workspace.slug,
          skillSlug: detail.skill.slug,
          contextSlug: context.slug,
        },
      )}
    >
      <ArrowLeftIcon weight="bold" aria-hidden="true" />
      {context.name}
    </a>

    <header>
      <span class="mark" aria-hidden="true">
        <ClockCounterClockwiseIcon weight="duotone" />
      </span>
      <div>
        <p>Append-only audit trail</p>
        <div class="title-row">
          <h2>Revision history</h2>
          <Badge tone="neutral">{knowledgeRevisions.length} knowledge revisions</Badge>
          <Badge tone="neutral">{notes.length} named notes</Badge>
        </div>
        <p>
          Inspect exact Markdown, provenance declarations, digests, base links, and
          learning metadata for every immutable revision.
        </p>
      </div>
    </header>

    <section class="picker">
      <Select
        label="History stream"
        options={[
          {
            value: "knowledge",
            label: `Shared context knowledge (${String(knowledgeRevisions.length)})`,
          },
          ...notes.map((note) => ({
            value: note.id,
            label: `${note.title} (${String(note.currentRevision)})${note.archivedAt ? " · archived" : ""}`,
          })),
        ]}
        bind:value={selected}
        onchange={() => void selectionChanged()}
      />
      <p>
        {selected === "knowledge"
          ? "The full shared knowledge document."
          : "A named shared note within this context."}
      </p>
    </section>

    {#if loadingRevisions}
      <SkillState
        kind="loading"
        title="Loading note history"
        message="Loading all immutable note revisions."
      />
    {:else if selected === "knowledge"}
      <RevisionHistory revisions={knowledgeRevisions} kind="knowledge" />
    {:else if noteRevisions.length > 0}
      <RevisionHistory revisions={noteRevisions} kind="note" />
    {:else}
      <SkillState
        kind="empty"
        title="No visible revisions"
        message="This history stream has no visible revisions."
      />
    {/if}
  </div>
{/if}

<style>
  .history-page {
    display: grid;
    gap: var(--sp-space-5);
  }

  .back {
    display: inline-flex;
    width: fit-content;
    align-items: center;
    gap: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-4);
    align-items: start;
  }

  .mark {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  h2,
  p {
    margin: 0;
  }

  header > div > p:first-child {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h2 {
    font-size: var(--sp-font-size-6);
    letter-spacing: -0.025em;
  }

  .title-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-space-2);
    margin-top: var(--sp-space-1);
  }

  header > div > p:last-child {
    max-width: 54rem;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
  }

  .picker {
    display: grid;
    grid-template-columns: minmax(16rem, 24rem) minmax(0, 1fr);
    gap: var(--sp-space-4);
    align-items: end;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-muted);
  }

  .picker p {
    padding-bottom: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  @media (max-width: 38rem) {
    .picker {
      grid-template-columns: 1fr;
    }

    .mark {
      display: none;
    }

    header {
      grid-template-columns: 1fr;
    }
  }
</style>
