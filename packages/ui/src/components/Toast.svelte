<script lang="ts">
  import { CheckCircleIcon, InfoIcon, WarningCircleIcon, XIcon } from "phosphor-svelte";
  import { onMount } from "svelte";
  import IconButton from "./IconButton.svelte";

  let {
    title,
    message,
    tone = "info",
    duration = 5_000,
    onDismiss,
  }: {
    title: string;
    message?: string;
    tone?: "success" | "warning" | "danger" | "info";
    duration?: number | null;
    onDismiss: () => void;
  } = $props();

  onMount(() => {
    if (duration === null) return;
    const timer = window.setTimeout(onDismiss, duration);
    return () => window.clearTimeout(timer);
  });
</script>

<section
  data-tone={tone}
  role={tone === "danger" || tone === "warning" ? "alert" : "status"}
  aria-atomic="true"
>
  <span class="icon" aria-hidden="true">
    {#if tone === "success"}
      <CheckCircleIcon weight="fill" />
    {:else if tone === "info"}
      <InfoIcon weight="fill" />
    {:else}
      <WarningCircleIcon weight="fill" />
    {/if}
  </span>
  <div>
    <strong>{title}</strong>
    {#if message}<p>{message}</p>{/if}
  </div>
  <IconButton size="sm" label="Dismiss notification" onclick={onDismiss}>
    <XIcon weight="bold" />
  </IconButton>
</section>

<style>
  section {
    display: grid;
    width: min(24rem, calc(100vw - var(--sp-space-6)));
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: start;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface-raised);
    box-shadow: var(--sp-shadow-md);
    color: var(--sp-color-text);
  }

  .icon {
    color: var(--sp-color-info);
  }

  section[data-tone="success"] .icon {
    color: var(--sp-color-success);
  }

  section[data-tone="warning"] .icon {
    color: var(--sp-color-warning);
  }

  section[data-tone="danger"] .icon {
    color: var(--sp-color-danger);
  }

  .icon :global(svg) {
    width: var(--sp-icon-lg);
    height: var(--sp-icon-lg);
  }

  strong,
  p {
    display: block;
    margin: 0;
  }

  strong {
    font-size: var(--sp-font-size-3);
  }

  p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    line-height: var(--sp-line-normal);
  }
</style>
