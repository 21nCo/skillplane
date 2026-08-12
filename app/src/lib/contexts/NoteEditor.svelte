<script lang="ts">
  import { getPostHog } from "$lib/analytics/posthog.client.js";
  import { SkillplaneApiError } from "$lib/api/client.js";
  import { SafeMarkdown } from "@skillplane/ui";
  import { Button, Input, Textarea } from "@skillplane/ui";
  import { ArrowsClockwiseIcon, WarningCircleIcon } from "phosphor-svelte";
  import { createContextNote, updateContextNote } from "./api.js";
  import {
    extraLearningMetadata,
    learningMetadata,
    learningSummary,
  } from "./metadata.js";
  import type { ContextNote } from "./types.js";

  let {
    workspaceId,
    contextId,
    note = null,
    onSaved,
    onCancel,
    onReload,
  }: {
    workspaceId: string;
    contextId: string;
    note?: ContextNote | null;
    onSaved: (note: ContextNote) => void;
    onCancel: () => void;
    onReload: () => void;
  } = $props();

  function initialNote() {
    return {
      title: note?.title ?? "",
      body: note?.body ?? "",
      summary: note ? learningSummary(note.learningMetadata) : "",
      extraSource: note ? extraLearningMetadata(note.learningMetadata) : "{}",
    };
  }

  const initial = initialNote();
  let title = $state(initial.title);
  let body = $state(initial.body);
  let summary = $state(initial.summary);
  let extraSource = $state(initial.extraSource);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let conflict = $state<number | null>(null);
  let requestFingerprint = "";
  let idempotencyKey = crypto.randomUUID();

  function changed() {
    error = null;
    conflict = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    conflict = null;
    try {
      const metadata = learningMetadata(summary, extraSource);
      const fingerprint = JSON.stringify({
        noteId: note?.id ?? null,
        expectedRevision: note?.currentRevision ?? null,
        title,
        body,
        metadata,
      });
      if (fingerprint !== requestFingerprint) {
        requestFingerprint = fingerprint;
        idempotencyKey = crypto.randomUUID();
      }
      const saved = note
        ? await updateContextNote({
            workspaceId,
            noteId: note.id,
            expectedRevision: note.currentRevision,
            title,
            body,
            learningMetadata: metadata,
            idempotencyKey,
          })
        : await createContextNote({
            workspaceId,
            contextId,
            title,
            body,
            learningMetadata: metadata,
            idempotencyKey,
          });
      getPostHog()?.capture("context_note_saved", {
        operation: note ? "updated" : "created",
      });
      onSaved(saved);
    } catch (cause) {
      if (
        cause instanceof SkillplaneApiError &&
        cause.code === "NOTE_REVISION_CONFLICT"
      ) {
        conflict =
          typeof cause.details?.currentRevision === "number"
            ? cause.details.currentRevision
            : (note?.currentRevision ?? 0);
      } else {
        error = cause instanceof Error ? cause.message : "The note could not be saved.";
      }
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={submit}>
  <header>
    <div>
      <p>
        {note ? `Editing revision ${String(note.currentRevision)}` : "New shared note"}
      </p>
      <h2>
        {note
          ? `Create note revision ${String(note.currentRevision + 1)}`
          : "Create note revision 1"}
      </h2>
    </div>
    <span>Shared with authorized agents</span>
  </header>

  <Input
    label="Note title"
    maxlength={240}
    required
    bind:value={title}
    oninput={changed}
    data-autofocus
  />

  <div class="editor-grid">
    <Textarea
      label="Note Markdown"
      rows={14}
      maxlength={262_144}
      required
      bind:value={body}
      oninput={changed}
    />
    <section class="preview" aria-label="Note preview">
      <span>Sanitized preview</span>
      {#if body.trim()}
        <SafeMarkdown source={body} />
      {:else}
        <p>Start writing to preview this shared note.</p>
      {/if}
    </section>
  </div>

  <div class="learning">
    <Input
      label="Learning summary"
      maxlength={2000}
      required
      bind:value={summary}
      oninput={changed}
    />
    <Textarea
      label="Additional learning metadata (JSON)"
      rows={5}
      required
      bind:value={extraSource}
      oninput={changed}
    />
  </div>

  {#if conflict !== null}
    <section class="conflict" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      <div>
        <strong>Note changed while you were editing</strong>
        <p>
          Revision {conflict} is current. Your source remains here and no last-write-wins
          update occurred.
        </p>
      </div>
      <Button type="button" variant="secondary" onclick={onReload}>
        {#snippet leading()}<ArrowsClockwiseIcon weight="bold" />{/snippet}
        Load current note
      </Button>
    </section>
  {/if}

  {#if error}
    <p class="error" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      {error}
    </p>
  {/if}

  <footer>
    <Button type="button" variant="secondary" onclick={onCancel}>Cancel</Button>
    <Button type="submit" loading={saving}>
      {note ? "Save immutable revision" : "Create shared note"}
    </Button>
  </footer>
</form>

<style>
  form {
    display: grid;
    gap: var(--sp-space-5);
  }

  header,
  footer,
  .conflict {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
  }

  header p,
  h2,
  .conflict p,
  .preview p {
    margin: 0;
  }

  header p,
  .preview > span {
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

  header span {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .editor-grid,
  .learning {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-4);
    align-items: start;
  }

  .preview {
    overflow: auto;
    min-height: 22rem;
    max-height: 36rem;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-4);
    background: var(--sp-color-canvas);
  }

  .preview > span {
    display: block;
    margin-bottom: var(--sp-space-3);
  }

  .preview p {
    color: var(--sp-color-text-subtle);
  }

  .learning {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface-muted);
  }

  .conflict {
    align-items: center;
    border: 1px solid var(--sp-color-warning);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-warning-soft);
    color: var(--sp-color-warning);
  }

  .conflict div {
    flex: 1;
  }

  .conflict p {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-3);
  }

  .error {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin: 0;
    color: var(--sp-color-danger);
  }

  footer {
    justify-content: flex-end;
  }

  @media (max-width: 56rem) {
    .editor-grid,
    .learning {
      grid-template-columns: 1fr;
    }

    .preview {
      min-height: 14rem;
    }

    .conflict {
      align-items: flex-start;
      flex-wrap: wrap;
    }
  }
</style>
