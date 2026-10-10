<script lang="ts">
  import { capturePostHog } from "$lib/analytics/posthog.client.js";
  import { Button, Input, Select, Textarea } from "@skillplane/ui";
  import MarkdownEditor from "$lib/markdown/MarkdownEditor.svelte";
  import { WarningCircleIcon } from "phosphor-svelte";
  import { createContext } from "./api.js";
  import { learningMetadata, parseJsonObject } from "./metadata.js";
  import type { ContextCreateResult, ContextType } from "./types.js";

  let {
    workspaceId,
    skillId,
    onCreated,
    onCancel,
  }: {
    workspaceId: string;
    skillId: string;
    onCreated: (result: ContextCreateResult) => void;
    onCancel?: () => void;
  } = $props();

  let name = $state("");
  let slug = $state("");
  let slugEdited = $state(false);
  let type = $state<ContextType>("repository");
  let externalReference = $state("");
  let description = $state("");
  let metadataSource = $state("{}");
  let knowledge = $state(
    "# Context knowledge\n\nRecord durable, project-specific facts and operating guidance here.\n",
  );
  let summary = $state("");
  let learningExtraSource = $state("{}");
  let saving = $state(false);
  let error = $state<string | null>(null);
  let requestFingerprint = "";
  let idempotencyKey = crypto.randomUUID();
  let capturedIdempotencyKey = "";

  function slugify(value: string): string {
    return value
      .toLocaleLowerCase()
      .trim()
      .replaceAll(/[^a-z0-9]+/gu, "-")
      .replaceAll(/^-+|-+$/gu, "")
      .slice(0, 120);
  }

  function nameChanged() {
    if (!slugEdited) slug = slugify(name);
    error = null;
  }

  function changed() {
    error = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    saving = true;
    error = null;
    try {
      const metadata = parseJsonObject(metadataSource, "Context metadata");
      const revisionMetadata = learningMetadata(summary, learningExtraSource);
      const payload = {
        slug,
        name,
        type,
        externalReference: externalReference.trim() || null,
        description,
        metadata,
        knowledge,
        learningMetadata: revisionMetadata,
      };
      const fingerprint = JSON.stringify(payload);
      if (fingerprint !== requestFingerprint) {
        requestFingerprint = fingerprint;
        idempotencyKey = crypto.randomUUID();
      }
      const submissionIdempotencyKey = idempotencyKey;
      const submittedContextType = type;
      const result = await createContext({
        workspaceId,
        skillId,
        ...payload,
        idempotencyKey: submissionIdempotencyKey,
      });
      if (capturedIdempotencyKey !== submissionIdempotencyKey) {
        capturePostHog("context_created", { context_type: submittedContextType });
        capturedIdempotencyKey = submissionIdempotencyKey;
      }
      onCreated(result);
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The context could not be created.";
    } finally {
      saving = false;
    }
  }
</script>

<form onsubmit={submit}>
  <header>
    <div>
      <p>New context</p>
      <h2>Create scoped knowledge</h2>
    </div>
    <span>Revision 1 is immutable</span>
  </header>

  <div class="two-column">
    <Input
      label="Name"
      placeholder="btnextjs"
      maxlength={160}
      required
      bind:value={name}
      oninput={nameChanged}
      data-autofocus
    />
    <Input
      label="Slug"
      description="Unique within this skill."
      placeholder="btnextjs"
      pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
      maxlength={120}
      required
      bind:value={slug}
      oninput={() => {
        slugEdited = true;
        changed();
      }}
    />
  </div>

  <div class="two-column">
    <Select
      label="Context type"
      options={[
        { value: "repository", label: "Repository" },
        { value: "project", label: "Project" },
        { value: "customer", label: "Customer" },
        { value: "environment", label: "Environment" },
        { value: "custom", label: "Custom" },
      ]}
      bind:value={type}
      onchange={changed}
    />
    <Input
      label="External reference"
      description="Optional stable reference such as repo:btnextjs."
      maxlength={2000}
      bind:value={externalReference}
      oninput={changed}
    />
  </div>

  <Textarea
    label="Description"
    rows={3}
    maxlength={2000}
    bind:value={description}
    oninput={changed}
  />

  <Textarea
    label="Context metadata (JSON)"
    description="Typed project attributes available to authorized clients."
    rows={5}
    required
    bind:value={metadataSource}
    oninput={changed}
  />

  <MarkdownEditor
    surface="context-create"
    label="Initial shared knowledge"
    description="Markdown source. This creates immutable knowledge revision 1."
    rows={12}
    required
    maxBytes={524_288}
    maxCharacters={524_288}
    bind:value={knowledge}
    oninput={changed}
  />

  <div class="learning">
    <Input
      label="Learning summary"
      description="Explain why this knowledge is useful."
      maxlength={2000}
      required
      bind:value={summary}
      oninput={changed}
    />
    <Textarea
      label="Additional learning metadata (JSON)"
      description="Optional evidence, confidence, references, tags, or custom fields."
      rows={5}
      required
      bind:value={learningExtraSource}
      oninput={changed}
    />
  </div>

  {#if error}
    <p class="error" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      {error}
    </p>
  {/if}

  <footer>
    {#if onCancel}
      <Button type="button" variant="secondary" onclick={onCancel}>Cancel</Button>
    {/if}
    <Button type="submit" loading={saving}>Create context</Button>
  </footer>
</form>

<style>
  form {
    display: grid;
    gap: var(--sp-space-5);
  }

  header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
    padding-bottom: var(--sp-space-4);
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

  header span {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-round);
    padding: var(--sp-space-1) var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .two-column,
  .learning {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-4);
    align-items: start;
  }

  .learning {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface-muted);
  }

  .error {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin: 0;
    color: var(--sp-color-danger);
    font-size: var(--sp-font-size-3);
  }

  footer {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-space-2);
  }

  @media (max-width: 48rem) {
    .two-column,
    .learning {
      grid-template-columns: 1fr;
    }

    header {
      flex-direction: column;
    }
  }
</style>
