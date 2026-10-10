<script lang="ts">
  import { FolderOpenIcon } from "phosphor-svelte";
  import type { Snippet } from "svelte";

  let {
    title,
    description,
    icon,
    action,
    compact = false,
  }: {
    title: string;
    description: string;
    icon?: Snippet;
    action?: Snippet;
    compact?: boolean;
  } = $props();
  const componentId = $props.id();
  const titleId = `${componentId}-title`;
</script>

<section class:compact aria-labelledby={titleId}>
  <div class="icon" aria-hidden="true">
    {#if icon}{@render icon()}{:else}<FolderOpenIcon weight="duotone" />{/if}
  </div>
  <h2 id={titleId}>{title}</h2>
  <p>{description}</p>
  {#if action}<div class="action">{@render action()}</div>{/if}
</section>

<style>
  section {
    display: grid;
    justify-items: center;
    border: 1px dashed var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-10) var(--sp-space-4);
    background: var(--sp-color-surface);
    text-align: center;
  }

  section.compact {
    padding: var(--sp-space-6) var(--sp-space-4);
  }

  .icon {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
  }

  .icon :global(svg) {
    width: var(--sp-icon-xl);
    height: var(--sp-icon-xl);
  }

  h2 {
    margin: var(--sp-space-3) 0 0;
    font-size: var(--sp-font-size-4);
  }

  p {
    max-width: 28rem;
    margin: var(--sp-space-1) 0 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  .action {
    margin-top: var(--sp-space-4);
  }
</style>
