<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    children,
    tone = "neutral",
  }: {
    children: Snippet;
    tone?: "neutral" | "accent" | "success" | "warning" | "danger" | "info";
  } = $props();
</script>

<span data-tone={tone}>{@render children()}</span>

<style>
  span {
    display: inline-flex;
    min-height: 1.25rem;
    align-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-round);
    padding: 0 var(--sp-space-2);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-medium);
    line-height: 1;
  }

  span[data-tone="accent"] {
    border-color: var(--sp-color-accent);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  span[data-tone="success"] {
    border-color: var(--sp-color-success);
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
  }

  span[data-tone="warning"] {
    border-color: var(--sp-color-warning);
    background: var(--sp-color-warning-soft);
    color: var(--sp-color-warning);
  }

  span[data-tone="danger"] {
    border-color: var(--sp-color-danger);
    background: var(--sp-color-danger-soft);
    color: var(--sp-color-danger);
  }

  span[data-tone="info"] {
    border-color: var(--sp-color-info);
    background: var(--sp-color-info-soft);
    color: var(--sp-color-info);
  }
</style>
