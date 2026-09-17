<script lang="ts">
  import { Button, EmptyState, ErrorState, Skeleton } from "@skillplane/ui";
  import { LockKeyIcon, MagnifyingGlassIcon } from "phosphor-svelte";
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

{#snippet emptyIcon()}
  <MagnifyingGlassIcon weight="duotone" />
{/snippet}

{#snippet emptyAction()}
  {#if retry}
    <Button size="sm" variant="secondary" onclick={retry}>Retry</Button>
  {/if}
  {#if children}{@render children()}{/if}
{/snippet}

{#if kind === "loading"}
  <section class="loading" aria-label={title} aria-busy="true">
    <Skeleton width="8rem" height="0.75rem" />
    <Skeleton width="70%" height="1.5rem" />
    <Skeleton width="100%" height="4rem" />
  </section>
{:else if kind === "empty"}
  <EmptyState
    {title}
    description={message}
    icon={emptyIcon}
    action={retry || children ? emptyAction : undefined}
  />
{:else if kind === "error" || kind === "conflict"}
  <ErrorState {title} description={message} {retry} />
{:else}
  <section class="authorization" role="status">
    <span class="icon" aria-hidden="true">
      <LockKeyIcon weight="duotone" />
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
  .authorization {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
  }

  .loading {
    display: grid;
    gap: var(--sp-space-3);
  }

  .authorization {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-3);
    align-items: start;
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

  .authorization :global(button),
  .actions {
    margin-top: var(--sp-space-3);
  }
</style>
