<script lang="ts">
  import type { HTMLTextareaAttributes } from "svelte/elements";

  interface Props extends Omit<HTMLTextareaAttributes, "value"> {
    label: string;
    value?: string;
    description?: string;
    error?: string;
    hideLabel?: boolean;
  }

  const generatedId = $props.id();
  let {
    label,
    value = $bindable(""),
    description,
    error,
    hideLabel = false,
    id = generatedId,
    rows = 4,
    ...rest
  }: Props = $props();
  const controlId = $derived(typeof id === "string" ? id : generatedId);
  const descriptionId = $derived(description ? `${controlId}-description` : undefined);
  const errorId = $derived(error ? `${controlId}-error` : undefined);
  const describedBy = $derived(
    [descriptionId, errorId, rest["aria-describedby"]].filter(Boolean).join(" ") ||
      undefined,
  );
</script>

<label class:visually-hidden={hideLabel} for={controlId}>{label}</label>
{#if description}<p id={descriptionId} class="description">{description}</p>{/if}
<textarea
  {...rest}
  id={controlId}
  {rows}
  bind:value
  aria-invalid={error ? "true" : undefined}
  aria-describedby={describedBy}></textarea>
{#if error}<p id={errorId} class="error" role="alert">{error}</p>{/if}

<style>
  label {
    display: block;
    margin-bottom: var(--sp-space-2);
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }

  .visually-hidden {
    position: absolute;
    overflow: hidden;
    width: 1px;
    height: 1px;
    margin: -1px;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  textarea {
    width: 100%;
    min-height: calc(var(--sp-row-height) * 2);
    resize: vertical;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
    padding: var(--sp-space-2) var(--sp-control-padding-x);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  textarea::placeholder {
    color: var(--sp-color-text-subtle);
  }

  textarea:focus {
    border-color: var(--sp-color-focus);
    box-shadow: 0 0 0 1px var(--sp-color-focus);
  }

  textarea[aria-invalid="true"] {
    border-color: var(--sp-color-danger);
  }

  textarea:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .description,
  .error {
    margin: 0 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .error {
    margin: var(--sp-space-2) 0 0;
    color: var(--sp-color-danger);
  }
</style>
