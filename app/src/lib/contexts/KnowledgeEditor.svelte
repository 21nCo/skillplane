<script lang="ts">
  import { capturePostHog } from "$lib/analytics/posthog.client.js";
  import { SkillplaneApiError } from "$lib/api/client.js";
  import { Button, Input, Textarea } from "@skillplane/ui";
  import MarkdownEditor from "$lib/markdown/MarkdownEditor.svelte";
  import { ArrowsClockwiseIcon, WarningCircleIcon } from "phosphor-svelte";
  import { updateContextKnowledge } from "./api.js";
  import {
    extraLearningMetadata,
    learningMetadata,
    learningSummary,
  } from "./metadata.js";
  import type { ContextKnowledgeRevision } from "./types.js";

  let {
    workspaceId,
    current,
    onSaved,
    onCancel,
    onReload,
  }: {
    workspaceId: string;
    current: ContextKnowledgeRevision;
    onSaved: (revision: ContextKnowledgeRevision) => void;
    onCancel: () => void;
    onReload: () => void;
  } = $props();

  function initialRevision() {
    return {
      body: current.body,
      summary: learningSummary(current.learningMetadata),
      extraSource: extraLearningMetadata(current.learningMetadata),
    };
  }

  const initial = initialRevision();
  let body = $state(initial.body);
  let summary = $state(initial.summary);
  let extraSource = $state(initial.extraSource);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let conflict = $state<{ revision: number; revisionId: string | null } | null>(null);
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
        expectedRevision: current.revision,
        body,
        metadata,
      });
      if (fingerprint !== requestFingerprint) {
        requestFingerprint = fingerprint;
        idempotencyKey = crypto.randomUUID();
      }
      const revision = await updateContextKnowledge({
        workspaceId,
        contextId: current.contextId,
        expectedRevision: current.revision,
        knowledge: body,
        learningMetadata: metadata,
        idempotencyKey,
      });
      capturePostHog("context_knowledge_revision_saved");
      onSaved(revision);
    } catch (cause) {
      if (
        cause instanceof SkillplaneApiError &&
        cause.code === "CONTEXT_REVISION_CONFLICT"
      ) {
        conflict = {
          revision:
            typeof cause.details?.currentRevision === "number"
              ? cause.details.currentRevision
              : current.revision,
          revisionId:
            typeof cause.details?.currentRevisionId === "string"
              ? cause.details.currentRevisionId
              : null,
        };
      } else {
        error =
          cause instanceof Error
            ? cause.message
            : "Context knowledge could not be updated.";
      }
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={submit}>
  <header>
    <div>
      <p>Editing revision {current.revision}</p>
      <h2>Create knowledge revision {current.revision + 1}</h2>
    </div>
    <code>{current.bodyDigest.slice(0, 19)}…</code>
  </header>

  <MarkdownEditor
    surface="knowledge-revise"
    label="Shared knowledge Markdown"
    mode="split"
    rows={18}
    required
    maxBytes={524_288}
    maxCharacters={524_288}
    bind:value={body}
    oninput={changed}
  />

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

  {#if conflict}
    <section class="conflict" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      <div>
        <strong>Knowledge changed while you were editing</strong>
        <p>
          Revision {conflict.revision} is current. Your source remains in this editor and
          has not overwritten the newer revision.
        </p>
      </div>
      <Button type="button" variant="secondary" onclick={onReload}>
        {#snippet leading()}<ArrowsClockwiseIcon weight="bold" />{/snippet}
        Load current revision
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
    <Button type="submit" loading={saving}>Save immutable revision</Button>
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
  .conflict p {
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

  header code {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .learning {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-4);
    align-items: start;
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

  .conflict > :global(svg) {
    flex: none;
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
    .learning {
      grid-template-columns: 1fr;
    }

    .conflict {
      align-items: flex-start;
      flex-wrap: wrap;
    }
  }
</style>
