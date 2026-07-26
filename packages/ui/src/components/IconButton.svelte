<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  interface Props extends HTMLButtonAttributes {
    label: string;
    children: Snippet;
    size?: "sm" | "md" | "lg";
    variant?: "secondary" | "ghost" | "danger";
  }

  let {
    label,
    children,
    size = "md",
    variant = "ghost",
    type = "button",
    ...rest
  }: Props = $props();
</script>

<button
  {...rest}
  {type}
  aria-label={label}
  title={rest.title ?? label}
  data-size={size}
  data-variant={variant}
>
  <span aria-hidden="true">{@render children()}</span>
</button>

<style>
  button {
    display: inline-grid;
    width: var(--sp-control-height);
    height: var(--sp-control-height);
    flex: 0 0 auto;
    place-items: center;
    border: 1px solid transparent;
    border-radius: var(--sp-radius-md);
    background: transparent;
    color: var(--sp-color-text-muted);
    cursor: pointer;
    transition:
      background var(--sp-duration-fast) var(--sp-ease-standard),
      color var(--sp-duration-fast) var(--sp-ease-standard);
  }

  button[data-size="sm"] {
    width: 1.75rem;
    height: 1.75rem;
  }

  button[data-size="lg"] {
    width: 2.5rem;
    height: 2.5rem;
  }

  button[data-variant="secondary"] {
    border-color: var(--sp-color-border);
    background: var(--sp-color-surface-raised);
  }

  button[data-variant="danger"] {
    color: var(--sp-color-danger);
  }

  button:hover:not(:disabled) {
    background: var(--sp-color-surface-hover);
    color: var(--sp-color-text);
  }

  button[data-variant="danger"]:hover:not(:disabled) {
    background: var(--sp-color-danger-soft);
    color: var(--sp-color-danger);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  button > span {
    display: inline-grid;
    place-items: center;
  }

  button :global(svg) {
    width: var(--sp-icon-md);
    height: var(--sp-icon-md);
  }

  button[data-size="sm"] :global(svg) {
    width: var(--sp-icon-sm);
    height: var(--sp-icon-sm);
  }

  button[data-size="lg"] :global(svg) {
    width: var(--sp-icon-lg);
    height: var(--sp-icon-lg);
  }
</style>
