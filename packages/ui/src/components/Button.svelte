<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HTMLButtonAttributes } from "svelte/elements";

  type Variant = "primary" | "secondary" | "ghost" | "danger";
  type Size = "sm" | "md";

  interface Props extends HTMLButtonAttributes {
    children: Snippet;
    leading?: Snippet;
    trailing?: Snippet;
    variant?: Variant;
    size?: Size;
    loading?: boolean;
    href?: string;
    target?: "_blank" | "_parent" | "_self" | "_top";
    rel?: string;
    download?: string | boolean;
  }

  let {
    children,
    leading,
    trailing,
    variant = "secondary",
    size = "md",
    loading = false,
    disabled = false,
    type = "button",
    href,
    target,
    rel,
    download,
    ...rest
  }: Props = $props();

  function handleLinkClick(event: MouseEvent) {
    if (disabled || loading) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const handler = rest.onclick as ((event: MouseEvent) => void) | null | undefined;
    handler?.(event);
  }
</script>

{#snippet content()}
  {#if loading}
    <span class="spinner" aria-hidden="true"></span>
  {:else if leading}
    <span class="icon" aria-hidden="true">{@render leading()}</span>
  {/if}
  <span class="label">{@render children()}</span>
  {#if trailing}<span class="icon" aria-hidden="true">{@render trailing()}</span>{/if}
{/snippet}

{#if href}
  <a
    {href}
    {target}
    {rel}
    {download}
    id={rest.id}
    class={rest.class}
    style={rest.style}
    title={rest.title}
    aria-label={rest["aria-label"]}
    aria-describedby={rest["aria-describedby"]}
    aria-current={rest["aria-current"]}
    aria-disabled={disabled ? true : loading ? true : undefined}
    aria-busy={loading || undefined}
    data-variant={variant}
    data-size={size}
    onclick={handleLinkClick}
  >
    {@render content()}
  </a>
{:else}
  <button
    {...rest}
    {type}
    {disabled}
    data-variant={variant}
    data-size={size}
    aria-busy={loading || undefined}
  >
    {@render content()}
  </button>
{/if}

<style>
  button,
  a {
    display: inline-flex;
    min-width: max-content;
    height: var(--sp-control-height);
    align-items: center;
    justify-content: center;
    gap: var(--sp-space-2);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-control-padding-x);
    box-shadow: var(--sp-shadow-sm);
    cursor: pointer;
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
    line-height: 1;
    text-decoration: none;
    transition:
      background var(--sp-duration-fast) var(--sp-ease-standard),
      border-color var(--sp-duration-fast) var(--sp-ease-standard),
      color var(--sp-duration-fast) var(--sp-ease-standard);
  }

  button[data-size="sm"],
  a[data-size="sm"] {
    height: 1.75rem;
    padding-inline: var(--sp-space-2);
    font-size: var(--sp-font-size-2);
  }

  button[data-variant="primary"],
  a[data-variant="primary"] {
    border-color: var(--sp-color-accent);
    background: var(--sp-color-accent);
    color: var(--sp-color-surface);
  }

  button[data-variant="primary"]:hover:not(:disabled),
  a[data-variant="primary"]:hover:not([aria-disabled="true"]) {
    border-color: var(--sp-color-accent-hover);
    background: var(--sp-color-accent-hover);
  }

  button[data-variant="secondary"],
  a[data-variant="secondary"] {
    background: var(--sp-color-surface-raised);
    color: var(--sp-color-text);
  }

  button[data-variant="secondary"]:hover:not(:disabled),
  button[data-variant="ghost"]:hover:not(:disabled),
  a[data-variant="secondary"]:hover:not([aria-disabled="true"]),
  a[data-variant="ghost"]:hover:not([aria-disabled="true"]) {
    background: var(--sp-color-surface-hover);
    color: var(--sp-color-text);
  }

  button[data-variant="ghost"],
  a[data-variant="ghost"] {
    border-color: transparent;
    background: transparent;
    box-shadow: none;
    color: var(--sp-color-text-muted);
  }

  button[data-variant="danger"],
  a[data-variant="danger"] {
    border-color: var(--sp-color-danger);
    background: var(--sp-color-danger);
    color: var(--sp-color-surface);
  }

  button[data-variant="danger"]:hover:not(:disabled),
  a[data-variant="danger"]:hover:not([aria-disabled="true"]) {
    border-color: var(--sp-color-danger-hover);
    background: var(--sp-color-danger-hover);
  }

  button:disabled,
  a[aria-disabled="true"] {
    cursor: not-allowed;
    opacity: 0.52;
  }

  .label {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .icon {
    display: inline-grid;
    flex: 0 0 auto;
    place-items: center;
  }

  .spinner {
    width: var(--sp-icon-sm);
    height: var(--sp-icon-sm);
    border: 2px solid currentcolor;
    border-right-color: transparent;
    border-radius: var(--sp-radius-round);
    animation: spin 700ms linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(1turn);
    }
  }
</style>
