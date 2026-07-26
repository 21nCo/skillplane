<script lang="ts">
  import { ArrowClockwiseIcon, WarningCircleIcon } from "phosphor-svelte";
  import Button from "./Button.svelte";

  let {
    title,
    description,
    retry,
    requestId,
  }: {
    title: string;
    description: string;
    retry?: () => void;
    requestId?: string;
  } = $props();
</script>

<section role="alert">
  <WarningCircleIcon class="icon" weight="duotone" aria-hidden="true" />
  <div>
    <h2>{title}</h2>
    <p>{description}</p>
    {#if requestId}<code>Reference {requestId}</code>{/if}
    {#if retry}
      <div class="action">
        <Button size="sm" variant="secondary" onclick={retry}>
          {#snippet leading()}<ArrowClockwiseIcon size={14} weight="bold" />{/snippet}
          Retry
        </Button>
      </div>
    {/if}
  </div>
</section>

<style>
  section {
    display: flex;
    gap: var(--sp-space-3);
    align-items: flex-start;
    border: 1px solid var(--sp-color-danger);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-danger-soft);
  }

  :global(.icon) {
    flex: 0 0 auto;
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
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  code {
    display: block;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .action {
    margin-top: var(--sp-space-3);
  }
</style>
