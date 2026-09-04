<script lang="ts">
  import { browser } from "$app/environment";
  import { SafeMarkdown, Textarea } from "@skillplane/ui";
  import { WarningCircleIcon } from "phosphor-svelte";
  import { encodedByteLength, markdownDiagnostics } from "./diagnostics.js";
  import { isMarkdownEditorEnabled } from "./flags.js";
  import {
    loadMarkdownEditor,
    type SkillplaneEditorController,
    type SkillplaneVisualEditorProps,
  } from "./load-editor.js";
  import type {
    MarkdownDiagnostic,
    MarkdownEditorLoadState,
    MarkdownEditorMode,
    MarkdownEditorSurface,
  } from "./types.js";
  import { untrack, type Component } from "svelte";

  const DIAGNOSTICS_DEBOUNCE_MS = 200;

  let {
    value = $bindable(""),
    mode = $bindable<MarkdownEditorMode>("source"),
    surface,
    readOnly = false,
    disabled = false,
    required = false,
    maxBytes,
    maxCharacters,
    label,
    description,
    rows = 16,
    onChange,
    onModeChange,
    oninput,
  }: {
    value?: string;
    mode?: MarkdownEditorMode;
    surface: MarkdownEditorSurface;
    readOnly?: boolean;
    disabled?: boolean;
    required?: boolean;
    maxBytes?: number;
    maxCharacters?: number;
    label: string;
    description?: string;
    rows?: number;
    onChange?: (next: string) => void;
    onModeChange?: (next: MarkdownEditorMode) => void;
    oninput?: (event: Event) => void;
  } = $props();

  const enabled = $derived(isMarkdownEditorEnabled(surface));
  const initialValue = value;
  let loadState = $state<MarkdownEditorLoadState>("source-fallback");
  let loadError = $state<string | null>(null);
  let VisualEditor = $state<Component<SkillplaneVisualEditorProps> | null>(null);
  let controller = $state<SkillplaneEditorController | null>(null);
  let diagnostics = $state<readonly MarkdownDiagnostic[]>([]);

  const dirty = $derived(value !== initialValue);
  const byteLength = $derived(encodedByteLength(value));
  const overBytes = $derived(
    typeof maxBytes === "number" ? byteLength > maxBytes : false,
  );
  const overCharacters = $derived(
    typeof maxCharacters === "number" ? value.length > maxCharacters : false,
  );
  const usesVisual = $derived(enabled && mode === "visual" && !readOnly);
  const showsLabeledSource = $derived(
    !enabled ||
      mode === "source" ||
      mode === "split" ||
      loadState === "failed" ||
      (mode === "visual" && (!usesVisual || loadState !== "ready")),
  );
  const showsVisual = $derived(
    usesVisual && loadState === "ready" && VisualEditor !== null && controller !== null,
  );
  const showsPreview = $derived(mode === "preview" || mode === "split");
  const visualReadOnly = $derived(readOnly || disabled);

  function emit(next: string) {
    if (next === value) return;
    value = next;
    onChange?.(next);
    oninput?.(new Event("input"));
  }

  function sourceInput(event: Event) {
    onChange?.(value);
    oninput?.(event);
  }

  function selectMode(next: MarkdownEditorMode) {
    if (next === mode) return;
    mode = next;
    onModeChange?.(next);
  }

  $effect(() => {
    if (!enabled) {
      diagnostics = [];
      return;
    }
    const source = value;
    const timer = setTimeout(() => {
      diagnostics = markdownDiagnostics(source);
    }, DIAGNOSTICS_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!browser || !usesVisual) {
      VisualEditor = null;
      controller = null;
      loadState = enabled ? "source-fallback" : "ready";
      loadError = null;
      return;
    }

    let cancelled = false;
    let unsubscribe: (() => void) | undefined;
    loadState = "loading";
    loadError = null;
    void loadMarkdownEditor()
      .then((loaded) => {
        if (cancelled) return;
        const current = untrack(() => value);
        VisualEditor = loaded.MdfnEditor;
        const next = loaded.createController(current);
        controller = next;
        loadState = "ready";
        unsubscribe = next.subscribe((change) => {
          emit(change.current.markdown);
        });
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        VisualEditor = null;
        controller = null;
        loadState = "failed";
        loadError =
          cause instanceof Error
            ? cause.message
            : "The visual Markdown editor could not be loaded.";
      });

    return () => {
      cancelled = true;
      unsubscribe?.();
      controller?.destroy?.();
    };
  });
</script>

<div
  class="markdown-editor"
  class:legacy={!enabled}
  data-testid="markdown-editor"
  data-surface={surface}
  data-mode={enabled ? mode : "legacy"}
  data-load-state={loadState}
>
  {#if enabled}
    <div class="toolbar">
      <div class="modes" role="tablist" aria-label={`${label} editor mode`}>
        {#each [{ id: "source", label: "Source" }, { id: "visual", label: "Visual" }, { id: "split", label: "Split" }, { id: "preview", label: "Preview" }] as tab (tab.id)}
          <button
            type="button"
            role="tab"
            aria-selected={mode === tab.id}
            data-testid={`markdown-mode-${tab.id}`}
            {disabled}
            onclick={() => selectMode(tab.id as MarkdownEditorMode)}
          >
            {tab.label}
          </button>
        {/each}
      </div>
      <p class="meta" data-testid="markdown-editor-size">
        {value.length.toLocaleString()} characters
        {#if typeof maxCharacters === "number"}
          / {maxCharacters.toLocaleString()}
        {/if}
        · {byteLength.toLocaleString()} bytes
        {#if typeof maxBytes === "number"}
          / {maxBytes.toLocaleString()}
        {/if}
        {#if dirty}
          · unsaved
        {/if}
      </p>
    </div>
  {/if}

  <div class="surfaces" class:split={showsLabeledSource && showsPreview}>
    {#if showsLabeledSource}
      <Textarea
        {label}
        {description}
        {rows}
        {required}
        {disabled}
        readonly={visualReadOnly}
        maxlength={maxCharacters}
        bind:value
        oninput={sourceInput}
        data-testid="markdown-editor-source"
      />
    {:else if required}
      <div class="constraint-control">
        <Textarea
          {label}
          hideLabel
          {required}
          maxlength={maxCharacters}
          tabindex={-1}
          bind:value
          data-testid="markdown-editor-constraint"
        />
      </div>
    {/if}

    {#if showsVisual && VisualEditor && controller}
      <div class="visual">
        <span class="visual-label">{label}</span>
        {#if description}
          <p class="visual-description">{description}</p>
        {/if}
        <VisualEditor
          {controller}
          mode="visual"
          readOnly={visualReadOnly}
          ariaLabel={label}
          onLoadError={(error) => {
            loadState = "failed";
            loadError = error.message;
          }}
        />
      </div>
    {/if}

    {#if showsPreview}
      <section class="preview" aria-label={`${label} preview`}>
        <span>Sanitized preview</span>
        {#if value.trim()}
          <SafeMarkdown source={value} />
        {:else}
          <p>Start writing to preview this Markdown.</p>
        {/if}
      </section>
    {/if}
  </div>

  {#if loadState === "failed" && loadError}
    <p class="notice" role="status">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      Visual editing is unavailable. Source is preserved. {loadError}
    </p>
  {/if}

  {#if overBytes || overCharacters}
    <p class="notice warning" role="status">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      {#if overBytes}
        This source exceeds the {maxBytes?.toLocaleString()} byte limit.
      {:else}
        This source exceeds the {maxCharacters?.toLocaleString()} character limit.
      {/if}
      The server remains the authority for accepted size.
    </p>
  {/if}

  {#if enabled && diagnostics.length > 0}
    <ul class="diagnostics" aria-label={`${label} diagnostics`}>
      {#each diagnostics as diagnostic, index (diagnostic.code + String(index))}
        <li data-severity={diagnostic.severity}>
          <strong>{diagnostic.code}</strong>
          {diagnostic.message}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<style>
  .markdown-editor {
    position: relative;
    display: grid;
    gap: var(--sp-space-3);
  }

  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
  }

  .modes {
    display: flex;
    overflow: auto;
    gap: var(--sp-space-1);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: 2px;
    background: var(--sp-color-surface-muted);
  }

  .modes button {
    min-height: 1.75rem;
    border: 0;
    border-radius: var(--sp-radius-sm);
    padding: 0 var(--sp-space-2);
    background: transparent;
    color: var(--sp-color-text-muted);
    cursor: pointer;
    font-size: var(--sp-font-size-2);
  }

  .modes button[aria-selected="true"] {
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
  }

  .modes button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .meta {
    margin: 0;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .surfaces {
    display: grid;
    gap: var(--sp-space-4);
  }

  .surfaces.split {
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
  }

  .constraint-control {
    position: absolute;
    overflow: hidden;
    width: 1px;
    height: 1px;
    margin: -1px;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .visual-label,
  .preview > span {
    display: block;
    margin-bottom: var(--sp-space-2);
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }

  .visual-description,
  .preview p {
    margin: 0 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .preview {
    overflow: auto;
    min-height: 16rem;
    max-height: 42rem;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-4);
    background: var(--sp-color-canvas);
  }

  .preview > span {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .notice,
  .diagnostics {
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .notice {
    display: flex;
    align-items: flex-start;
    gap: var(--sp-space-2);
  }

  .notice.warning,
  .diagnostics li[data-severity="warning"] {
    color: var(--sp-color-warning);
  }

  .diagnostics {
    display: grid;
    gap: var(--sp-space-1);
    padding-left: 1.1rem;
  }

  .diagnostics li[data-severity="error"] {
    color: var(--sp-color-danger);
  }

  @media (max-width: 56rem) {
    .surfaces.split {
      grid-template-columns: 1fr;
    }
  }
</style>
