<script lang="ts">
  import { Badge } from "@skillplane/ui";
  import { FileZipIcon, UploadSimpleIcon } from "phosphor-svelte";
  import { inspectSkillBundle, type InspectedSkillBundle } from "./bundle.js";

  let {
    disabled = false,
    onBundle,
  }: {
    disabled?: boolean;
    onBundle: (bytes: Uint8Array | null, summary: InspectedSkillBundle | null) => void;
  } = $props();

  let fileName = $state<string | null>(null);
  let fileSize = $state<number | null>(null);
  let summary = $state<InspectedSkillBundle | null>(null);
  let error = $state<string | null>(null);

  async function selectBundle(event: Event) {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    error = null;
    summary = null;
    fileName = file?.name ?? null;
    fileSize = file?.size ?? null;
    if (!file) {
      onBundle(null, null);
      return;
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const inspected = inspectSkillBundle(bytes);
      summary = inspected;
      onBundle(bytes, inspected);
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "The selected bundle could not be inspected.";
      onBundle(null, null);
    }
  }
</script>

<div class="uploader">
  <label class:disabled>
    <span class="upload-icon" aria-hidden="true">
      <UploadSimpleIcon weight="bold" />
    </span>
    <span>
      <strong>Choose a ZIP skill bundle</strong>
      <small>Maximum 10 MiB · SKILL.md and skill.json required</small>
    </span>
    <input
      type="file"
      accept=".zip,application/zip"
      {disabled}
      onchange={selectBundle}
      aria-describedby={error ? "bundle-error" : undefined}
    />
  </label>

  {#if summary}
    <div class="summary" role="status">
      <FileZipIcon weight="duotone" aria-hidden="true" />
      <span>
        <strong>{summary.name}</strong>
        <small>
          {fileName} · {summary.fileCount} files ·
          {fileSize === null ? "unknown size" : `${(fileSize / 1024).toFixed(1)} KiB`}
        </small>
      </span>
      <Badge tone="success">Format v{summary.formatVersion}</Badge>
    </div>
  {/if}

  {#if error}<p id="bundle-error" class="error" role="alert">{error}</p>{/if}
</div>

<style>
  .uploader {
    display: grid;
    gap: var(--sp-space-3);
  }

  label {
    position: relative;
    display: grid;
    min-height: 7rem;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-3);
    align-items: center;
    border: 1px dashed var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
    cursor: pointer;
  }

  label:hover {
    border-color: var(--sp-color-accent);
    background: var(--sp-color-surface-hover);
  }

  label.disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }

  .upload-icon {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  strong,
  small {
    display: block;
  }

  small {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-muted);
  }

  .summary :global(svg) {
    color: var(--sp-color-accent-text);
  }

  .error {
    margin: 0;
    color: var(--sp-color-danger);
    font-size: var(--sp-font-size-3);
  }
</style>
