<script lang="ts">
  import { CaretDownIcon } from "phosphor-svelte";
  import type { HTMLSelectAttributes } from "svelte/elements";

  export interface SelectOption {
    readonly value: string;
    readonly label: string;
    readonly disabled?: boolean;
  }

  interface Props extends Omit<HTMLSelectAttributes, "value"> {
    label: string;
    options: readonly SelectOption[];
    value?: string;
    description?: string;
    error?: string;
    placeholder?: string;
  }

  const generatedId = $props.id();
  let {
    label,
    options,
    value = $bindable(""),
    description,
    error,
    placeholder,
    id = generatedId,
    ...rest
  }: Props = $props();
  const controlId = $derived(typeof id === "string" ? id : generatedId);
  const descriptionId = $derived(description ? `${controlId}-description` : undefined);
  const errorId = $derived(error ? `${controlId}-error` : undefined);
</script>

<label for={controlId}>{label}</label>
{#if description}<p id={descriptionId} class="description">{description}</p>{/if}
<div class="select-wrap">
  <select
    {...rest}
    id={controlId}
    bind:value
    aria-invalid={error ? "true" : undefined}
    aria-describedby={[descriptionId, errorId].filter(Boolean).join(" ") || undefined}
  >
    {#if placeholder}<option value="" disabled>{placeholder}</option>{/if}
    {#each options as option (option.value)}
      <option value={option.value} disabled={option.disabled}>{option.label}</option>
    {/each}
  </select>
  <CaretDownIcon size={14} weight="bold" aria-hidden="true" />
</div>
{#if error}<p id={errorId} class="error" role="alert">{error}</p>{/if}

<style>
  label {
    display: block;
    margin-bottom: var(--sp-space-2);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }

  .select-wrap {
    position: relative;
  }

  select {
    width: 100%;
    height: var(--sp-control-height);
    appearance: none;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
    padding: 0 calc(var(--sp-control-padding-x) + 1.25rem) 0 var(--sp-control-padding-x);
    font-size: var(--sp-font-size-3);
    cursor: pointer;
  }

  select:focus {
    border-color: var(--sp-color-focus);
    box-shadow: 0 0 0 1px var(--sp-color-focus);
  }

  select[aria-invalid="true"] {
    border-color: var(--sp-color-danger);
  }

  .select-wrap :global(svg) {
    position: absolute;
    top: 50%;
    right: var(--sp-space-3);
    pointer-events: none;
    color: var(--sp-color-text-subtle);
    transform: translateY(-50%);
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
