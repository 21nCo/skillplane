<script lang="ts">
  import type { HTMLInputAttributes } from "svelte/elements";

  interface Props extends Omit<HTMLInputAttributes, "value"> {
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
<input
  {...rest}
  id={controlId}
  bind:value
  aria-invalid={error ? "true" : undefined}
  aria-describedby={describedBy}
/>
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

  input {
    width: 100%;
    height: var(--sp-control-height);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
    padding: 0 var(--sp-control-padding-x);
    font-size: var(--sp-font-size-3);
    transition:
      border-color var(--sp-duration-fast) var(--sp-ease-standard),
      box-shadow var(--sp-duration-fast) var(--sp-ease-standard);
  }

  input::placeholder {
    color: var(--sp-color-text-subtle);
  }

  input:hover:not(:disabled) {
    border-color: var(--sp-color-border-strong);
  }

  input:focus {
    border-color: var(--sp-color-focus);
    box-shadow: 0 0 0 1px var(--sp-color-focus);
  }

  input[aria-invalid="true"] {
    border-color: var(--sp-color-danger);
  }

  input:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .description,
  .error {
    margin: 0 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    line-height: var(--sp-line-normal);
  }

  .error {
    margin: var(--sp-space-2) 0 0;
    color: var(--sp-color-danger);
  }
</style>
