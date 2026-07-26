<script lang="ts">
  import { Button, Skeleton } from "@skillplane/ui";
  import { LockKeyIcon, MagnifyingGlassIcon, WarningCircleIcon } from "phosphor-svelte";
  import type { Snippet } from "svelte";

  type StateKind = "loading" | "empty" | "error" | "authorization" | "conflict";

  let {
    kind,
    title,
    message,
    retry,
    children,
  }: {
    kind: StateKind;
    title: string;
    message: string;
    retry?: () => void;
    children?: Snippet;
  } = $props();
</script>

{#if kind === "loading"}
  <section class="loading" aria-label={title} aria-busy="true">
    <Skeleton width="8rem" height="0.75rem" />
    <Skeleton width="70%" height="1.5rem" />
    <Skeleton width="100%" height="4rem" />
  </section>
{:else}
  <section
    class="state"
    class:error={kind === "error" || kind === "conflict"}
    role={kind === "error" || kind === "conflict" ? "alert" : "status"}
  >
    <span class="icon" aria-hidden="true">
      {#if kind === "authorization"}
        <LockKeyIcon weight="duotone" />
      {:else if kind === "empty"}
        <MagnifyingGlassIcon weight="duotone" />
      {:else}
        <WarningCircleIcon weight="duotone" />
      {/if}
    </span>
    <div>
      <h2>{title}</h2>
      <p>{message}</p>
      {#if retry}
        <Button size="sm" variant="secondary" onclick={retry}>Retry</Button>
      {/if}
      {#if children}<div class="actions">{@render children()}</div>{/if}
    </div>
  </section>
{/if}

<style>
  .loading,
  .state {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
  }

  .loading {
    display: grid;
    gap: var(--sp-space-3);
  }

  .state {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-3);
    align-items: start;
  }

  .state.error {
    border-color: var(--sp-color-danger);
    background: var(--sp-color-danger-soft);
  }

  .icon {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
  }

  .error .icon {
    color: var(--sp-color-danger);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--sp-font-size-4);
  }

  p {
    max-width: 52rem;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  .state :global(button),
  .actions {
    margin-top: var(--sp-space-3);
  }
</style>
