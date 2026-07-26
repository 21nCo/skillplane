<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import ContextProfileEditor from "$lib/contexts/ContextProfileEditor.svelte";
  import KnowledgeEditor from "$lib/contexts/KnowledgeEditor.svelte";
  import NoteEditor from "$lib/contexts/NoteEditor.svelte";
  import {
    archiveContextNote,
    getContextBySlug,
    getContextKnowledge,
    listContextNotes,
    setContextArchived,
  } from "$lib/contexts/api.js";
  import { learningSummary } from "$lib/contexts/metadata.js";
  import type {
    ContextArchiveFilter,
    ContextKnowledgeRevision,
    ContextNote,
    SkillContext,
  } from "$lib/contexts/types.js";
  import { SafeMarkdown } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { Badge, Button, Dialog, Select, Toast } from "@skillplane/ui";
  import {
    ArchiveIcon,
    ArrowLeftIcon,
    ClockCounterClockwiseIcon,
    NotePencilIcon,
    PencilSimpleIcon,
    PlusIcon,
    StackIcon,
  } from "phosphor-svelte";

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

  let context = $state<SkillContext | null>(null);
  let knowledge = $state<ContextKnowledgeRevision | null>(null);
  let notes = $state<readonly ContextNote[]>([]);
  let noteFilter = $state<ContextArchiveFilter>("active");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadKey = $state("");
  let editingProfile = $state(false);
  let editingKnowledge = $state(false);
  let editingNote = $state<ContextNote | "new" | null>(null);
  let archiveNote = $state<ContextNote | null>(null);
  let lifecycleDialog = $state(false);
  let mutating = $state(false);
  let toast = $state<{ title: string; message: string } | null>(null);

  async function load() {
    if (!workspace || !detail.skill) return;
    loading = true;
    error = null;
    try {
      const loadedContext = await getContextBySlug({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        contextSlug: page.params.contextSlug ?? "",
      });
      const [loadedKnowledge, loadedNotes] = await Promise.all([
        getContextKnowledge(workspace.id, loadedContext.id),
        listContextNotes({
          workspaceId: workspace.id,
          contextId: loadedContext.id,
          archive: noteFilter,
        }),
      ]);
      context = loadedContext;
      knowledge = loadedKnowledge;
      notes = loadedNotes;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The context could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function reloadKnowledge() {
    if (!workspace || !context) return;
    try {
      const currentContext = context;
      const currentKnowledge = await getContextKnowledge(
        workspace.id,
        currentContext.id,
      );
      knowledge = currentKnowledge;
      context = {
        ...currentContext,
        currentKnowledgeRevisionId: currentKnowledge.id,
        currentKnowledgeRevision: currentKnowledge.revision,
        updatedAt: currentKnowledge.createdAt,
      };
      editingKnowledge = false;
      toast = {
        title: "Current revision loaded",
        message: `Knowledge revision ${String(currentKnowledge.revision)} is ready.`,
      };
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "Current knowledge could not be loaded.";
    }
  }

  async function reloadNotes() {
    if (!workspace || !context) return;
    notes = await listContextNotes({
      workspaceId: workspace.id,
      contextId: context.id,
      archive: noteFilter,
    });
  }

  async function reloadEditingNote() {
    if (!editingNote || editingNote === "new") return;
    const noteId = editingNote.id;
    await reloadNotes();
    editingNote = notes.find((note) => note.id === noteId) ?? null;
    toast = {
      title: "Current note loaded",
      message: "Your prior draft was discarded only after you requested a reload.",
    };
  }

  async function changeLifecycle() {
    if (!workspace || !context) return;
    mutating = true;
    try {
      const archived = !context.archivedAt;
      context = await setContextArchived({
        workspaceId: workspace.id,
        contextId: context.id,
        archived,
        idempotencyKey: crypto.randomUUID(),
      });
      lifecycleDialog = false;
      toast = {
        title: archived ? "Context archived" : "Context restored",
        message: archived
          ? "It is now excluded from active context retrieval."
          : "It is active and available to authorized clients again.",
      };
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Context lifecycle could not change.";
    } finally {
      mutating = false;
    }
  }

  async function confirmArchiveNote() {
    if (!workspace || !archiveNote) return;
    mutating = true;
    try {
      await archiveContextNote({
        workspaceId: workspace.id,
        noteId: archiveNote.id,
        idempotencyKey: crypto.randomUUID(),
      });
      archiveNote = null;
      await reloadNotes();
      toast = {
        title: "Note archived",
        message: "Its immutable revision history remains available.",
      };
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The note could not be archived.";
    } finally {
      mutating = false;
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
  <title>{context?.name ?? "Context"} · {detail.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if loading}
  <SkillState
    kind="loading"
    title="Loading context knowledge"
    message="Loading the current immutable revisions and shared notes."
  />
{:else if error !== null || !context || !knowledge || !workspace || !detail.skill}
  <SkillState
    kind="error"
    title="Context could not be loaded"
    message={error ?? "The context does not exist or access was removed."}
    retry={() => void load()}
  />
{:else}
  <div class="context-detail">
    <a
      class="back"
      href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/contexts", {
        workspaceSlug: workspace.slug,
        skillSlug: detail.skill.slug,
      })}
    >
      <ArrowLeftIcon weight="bold" aria-hidden="true" /> Contexts
    </a>

    <header class="context-heading">
      <div class="context-mark" aria-hidden="true">
        {#if context.archivedAt}
          <ArchiveIcon weight="duotone" />
        {:else}
          <StackIcon weight="duotone" />
        {/if}
      </div>
      <div>
        <div class="title-row">
          <h2>{context.name}</h2>
          <Badge tone="info">{context.type}</Badge>
          {#if context.archivedAt}<Badge tone="warning">Archived</Badge>{/if}
        </div>
        <p>{context.description || "No description provided."}</p>
        <div class="meta">
          <code>{context.slug}</code>
          {#if context.externalReference}<span>{context.externalReference}</span>{/if}
          <span>Knowledge revision {context.currentKnowledgeRevision}</span>
        </div>
      </div>
      {#if canWrite}
        <div class="heading-actions">
          <Button size="sm" variant="secondary" onclick={() => (editingProfile = true)}>
            {#snippet leading()}<PencilSimpleIcon weight="bold" />{/snippet}
            Edit details
          </Button>
          <Button
            size="sm"
            variant={context.archivedAt ? "secondary" : "danger"}
            onclick={() => (lifecycleDialog = true)}
          >
            {context.archivedAt ? "Restore" : "Archive"}
          </Button>
        </div>
      {/if}
    </header>

    {#if page.url.searchParams.get("created") === "true"}
      <div class="success" role="status">
        Context and immutable knowledge revision 1 were created successfully.
      </div>
    {/if}

    {#if workspace.role === "viewer"}
      <p class="role-note">
        Read-only access: your viewer role can inspect knowledge, notes, learning
        metadata, and revision history.
      </p>
    {/if}

    <section class="profile panel">
      <div class="panel-heading">
        <div>
          <p>Context profile</p>
          <h3>Retrieval metadata</h3>
        </div>
      </div>
      <dl>
        <div>
          <dt>Type</dt>
          <dd>{context.type}</dd>
        </div>
        <div>
          <dt>External reference</dt>
          <dd>{context.externalReference ?? "Not set"}</dd>
        </div>
        <div class="wide">
          <dt>Metadata</dt>
          <dd><pre>{JSON.stringify(context.metadata, null, 2)}</pre></dd>
        </div>
      </dl>
    </section>

    <section class="knowledge panel">
      <div class="panel-heading">
        <div>
          <p>Shared source of truth</p>
          <h3>Context knowledge</h3>
        </div>
        <div class="panel-actions">
          <Badge tone="success">Revision {knowledge.revision}</Badge>
          <Button
            size="sm"
            variant="secondary"
            href={resolve(
              "/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]/history",
              {
                workspaceSlug: workspace.slug,
                skillSlug: detail.skill.slug,
                contextSlug: context.slug,
              },
            )}
          >
            {#snippet leading()}<ClockCounterClockwiseIcon weight="bold" />{/snippet}
            History
          </Button>
          {#if canWrite && !context.archivedAt}
            <Button size="sm" onclick={() => (editingKnowledge = true)}>
              {#snippet leading()}<PencilSimpleIcon weight="bold" />{/snippet}
              Amend knowledge
            </Button>
          {/if}
        </div>
      </div>
      <p class="learning-summary">{learningSummary(knowledge.learningMetadata)}</p>
      <div class="rendered"><SafeMarkdown source={knowledge.body} /></div>
      <details>
        <summary>Exact Markdown and learning metadata</summary>
        <div class="source-grid">
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Named focusable scroll regions let keyboard users inspect exact source.) -->
          <pre tabindex="0" aria-label="Exact knowledge Markdown"><code
              >{knowledge.body}</code
            ></pre>
          <!-- svelte-ignore a11y_no_noninteractive_tabindex (Named focusable scroll regions let keyboard users inspect metadata.) -->
          <pre tabindex="0" aria-label="Knowledge learning metadata"><code
              >{JSON.stringify(knowledge.learningMetadata, null, 2)}</code
            ></pre>
        </div>
      </details>
    </section>

    <section class="notes panel">
      <div class="panel-heading">
        <div>
          <p>Shared working memory</p>
          <h3>Context notes</h3>
        </div>
        <div class="panel-actions">
          <Select
            label="Note lifecycle"
            options={[
              { value: "active", label: "Active notes" },
              { value: "archived", label: "Archived notes" },
              { value: "all", label: "All notes" },
            ]}
            bind:value={noteFilter}
            onchange={() => void reloadNotes()}
          />
          {#if canWrite && !context.archivedAt}
            <Button size="sm" onclick={() => (editingNote = "new")}>
              {#snippet leading()}<PlusIcon weight="bold" />{/snippet}
              New note
            </Button>
          {/if}
        </div>
      </div>

      {#if notes.length === 0}
        <SkillState
          kind="empty"
          title={noteFilter === "active" ? "No active notes" : "No notes here"}
          message={canWrite && !context.archivedAt
            ? "Create a shared note for a focused decision, convention, or learning."
            : "No notes are visible for this lifecycle filter."}
        />
      {:else}
        <div class="note-grid">
          {#each notes as note (note.id)}
            <article class:archived={Boolean(note.archivedAt)}>
              <header>
                <span class="note-mark" aria-hidden="true">
                  <NotePencilIcon weight="duotone" />
                </span>
                <div>
                  <div class="title-row">
                    <h4>{note.title}</h4>
                    <Badge tone="neutral">Revision {note.currentRevision}</Badge>
                    {#if note.archivedAt}<Badge tone="warning">Archived</Badge>{/if}
                  </div>
                  <p>{learningSummary(note.learningMetadata)}</p>
                </div>
              </header>
              <div class="note-body"><SafeMarkdown source={note.body} /></div>
              <footer>
                <code>{note.bodyDigest.slice(0, 19)}…</code>
                <div>
                  <Button
                    size="sm"
                    variant="ghost"
                    href={`${resolve(
                      "/(app)/[workspaceSlug]/skills/[skillSlug]/contexts/[contextSlug]/history",
                      {
                        workspaceSlug: workspace.slug,
                        skillSlug: detail.skill.slug,
                        contextSlug: context.slug,
                      },
                    )}?note=${encodeURIComponent(note.id)}`}
                  >
                    History
                  </Button>
                  {#if canWrite && !context.archivedAt && !note.archivedAt}
                    <Button
                      size="sm"
                      variant="secondary"
                      onclick={() => (editingNote = note)}
                    >
                      Edit
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onclick={() => (archiveNote = note)}
                    >
                      Archive
                    </Button>
                  {/if}
                </div>
              </footer>
            </article>
          {/each}
        </div>
      {/if}
    </section>
  </div>

  <Dialog
    bind:open={editingProfile}
    title="Edit context details"
    description="This changes retrieval metadata; knowledge remains independently versioned."
  >
    {#key context.updatedAt}
      <ContextProfileEditor
        workspaceId={workspace.id}
        {context}
        onSaved={(saved) => {
          context = saved;
          editingProfile = false;
          toast = {
            title: "Context updated",
            message: "Retrieval metadata was saved.",
          };
        }}
        onCancel={() => (editingProfile = false)}
      />
    {/key}
  </Dialog>

  <Dialog
    bind:open={editingKnowledge}
    title="Amend context knowledge"
    description="Updates require the expected current revision; stale writes never overwrite newer learning."
  >
    {#key knowledge.id}
      <KnowledgeEditor
        workspaceId={workspace.id}
        current={knowledge}
        onSaved={(saved) => {
          const currentContext = context;
          if (!currentContext) return;
          knowledge = saved;
          context = {
            ...currentContext,
            currentKnowledgeRevisionId: saved.id,
            currentKnowledgeRevision: saved.revision,
            updatedAt: saved.createdAt,
          };
          editingKnowledge = false;
          toast = {
            title: `Knowledge revision ${String(saved.revision)} created`,
            message: "The prior revision remains immutable and available in history.",
          };
        }}
        onCancel={() => (editingKnowledge = false)}
        onReload={reloadKnowledge}
      />
    {/key}
  </Dialog>

  <Dialog
    open={editingNote !== null}
    onOpenChange={(open) => {
      if (!open) editingNote = null;
    }}
    title={editingNote === "new" ? "Create shared note" : "Amend shared note"}
    description="Named notes preserve focused learnings as immutable revisions."
  >
    {#key editingNote === "new" ? "new" : (editingNote?.currentRevisionId ?? "closed")}
      <NoteEditor
        workspaceId={workspace.id}
        contextId={context.id}
        note={editingNote === "new" ? null : editingNote}
        onSaved={(saved) => {
          editingNote = null;
          void reloadNotes();
          toast = {
            title: `Note revision ${String(saved.currentRevision)} saved`,
            message: "The shared note and learning metadata are durable.",
          };
        }}
        onCancel={() => (editingNote = null)}
        onReload={reloadEditingNote}
      />
    {/key}
  </Dialog>

  <Dialog
    bind:open={lifecycleDialog}
    title={context.archivedAt ? "Restore context?" : "Archive context?"}
    description={context.archivedAt
      ? "The context will return to active retrieval."
      : "Active retrieval will exclude this context, but all knowledge and note revisions remain durable."}
  >
    <p class="dialog-copy">
      {context.archivedAt
        ? `Restore ${context.name} for authorized agents and users?`
        : `Archive ${context.name} and its active notes?`}
    </p>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (lifecycleDialog = false)}>
        Cancel
      </Button>
      <Button
        variant={context?.archivedAt ? "primary" : "danger"}
        loading={mutating}
        onclick={changeLifecycle}
        data-autofocus
      >
        {context?.archivedAt ? "Restore context" : "Archive context"}
      </Button>
    {/snippet}
  </Dialog>

  <Dialog
    open={archiveNote !== null}
    onOpenChange={(open) => {
      if (!open) archiveNote = null;
    }}
    title="Archive shared note?"
    description="The note leaves active retrieval; its immutable revisions remain in history."
  >
    <p class="dialog-copy">Archive “{archiveNote?.title}”?</p>
    {#snippet footer()}
      <Button variant="secondary" onclick={() => (archiveNote = null)}>Cancel</Button>
      <Button
        variant="danger"
        loading={mutating}
        onclick={confirmArchiveNote}
        data-autofocus
      >
        Archive note
      </Button>
    {/snippet}
  </Dialog>

  {#if toast}
    <div class="toast-rack">
      <Toast
        title={toast.title}
        message={toast.message}
        tone="success"
        onDismiss={() => (toast = null)}
      />
    </div>
  {/if}
{/if}

<style>
  .context-detail {
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

  .context-heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-4);
    align-items: start;
  }

  .context-mark,
  .note-mark {
    display: grid;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .context-mark {
    width: 2.75rem;
    height: 2.75rem;
  }

  .title-row,
  .meta,
  .heading-actions,
  .panel-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-space-2);
  }

  h2,
  h3,
  h4,
  p,
  dl,
  dt,
  dd {
    margin: 0;
  }

  h2 {
    font-size: var(--sp-font-size-6);
    letter-spacing: -0.025em;
  }

  .context-heading p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
  }

  .meta {
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .success,
  .role-note {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3) var(--sp-space-4);
    font-size: var(--sp-font-size-3);
  }

  .success {
    border-color: var(--sp-color-success);
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
  }

  .role-note {
    color: var(--sp-color-text-muted);
  }

  .panel {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  .panel-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-4);
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .panel-heading p {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h3 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }

  .profile dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-4);
    padding: var(--sp-space-4);
  }

  .profile .wide {
    grid-column: 1 / -1;
  }

  dt {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    text-transform: uppercase;
  }

  dd {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
  }

  pre {
    overflow: auto;
    max-height: 20rem;
    margin: 0;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-canvas);
    color: var(--sp-color-text-muted);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
    white-space: pre-wrap;
  }

  .learning-summary {
    padding: var(--sp-space-3) var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .rendered,
  .note-body {
    padding: var(--sp-space-4);
  }

  details {
    border-top: 1px solid var(--sp-color-border);
    padding: var(--sp-space-3) var(--sp-space-4) var(--sp-space-4);
  }

  summary {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
    cursor: pointer;
  }

  .source-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3);
    margin-top: var(--sp-space-3);
  }

  .note-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3);
    padding: var(--sp-space-4);
  }

  .note-grid article {
    display: flex;
    min-height: 15rem;
    flex-direction: column;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-canvas);
  }

  .note-grid article.archived {
    opacity: 0.74;
  }

  .note-grid article > header {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-3);
    align-items: start;
    padding: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .note-mark {
    width: 2rem;
    height: 2rem;
  }

  h4 {
    font-size: var(--sp-font-size-4);
  }

  .note-grid header p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .note-body {
    flex: 1;
    font-size: var(--sp-font-size-3);
  }

  .note-grid footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-2);
    padding: var(--sp-space-3);
    border-top: 1px solid var(--sp-color-border);
  }

  .note-grid footer code {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .note-grid footer div {
    display: flex;
    gap: var(--sp-space-1);
  }

  .dialog-copy {
    color: var(--sp-color-text-muted);
  }

  .toast-rack {
    position: fixed;
    z-index: 60;
    right: var(--sp-space-5);
    bottom: var(--sp-space-5);
  }

  @media (max-width: 52rem) {
    .note-grid,
    .source-grid {
      grid-template-columns: 1fr;
    }

    .context-heading {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .heading-actions {
      grid-column: 2;
    }
  }

  @media (max-width: 38rem) {
    .panel-heading,
    .context-heading {
      align-items: stretch;
    }

    .panel-heading {
      flex-direction: column;
    }

    .context-heading {
      grid-template-columns: 1fr;
    }

    .context-mark {
      display: none;
    }

    .heading-actions {
      grid-column: 1;
    }

    .profile dl {
      grid-template-columns: 1fr;
    }

    .profile .wide {
      grid-column: auto;
    }

    .toast-rack {
      right: var(--sp-space-3);
      bottom: var(--sp-space-3);
    }
  }
</style>
