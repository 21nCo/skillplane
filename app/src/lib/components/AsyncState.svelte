<script lang="ts">
  import {
    ArrowClockwiseIcon as ArrowClockwise,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";

  let {
    title,
    message,
    retry,
  }: {
    title: string;
    message: string;
    retry?: () => void;
  } = $props();
</script>

<section class="state" role={retry ? "alert" : "status"}>
  <WarningCircle size={22} weight="duotone" aria-hidden="true" />
  <div>
    <h2>{title}</h2>
    <p>{message}</p>
    {#if retry}
      <button type="button" onclick={retry}>
        <ArrowClockwise size={15} weight="bold" aria-hidden="true" /> Retry
      </button>
    {/if}
  </div>
</section>

<style>
  .state {
    display: flex;
    gap: 0.85rem;
    align-items: flex-start;
    padding: 1.25rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
    color: var(--text-secondary);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    color: var(--text);
    font-size: 0.92rem;
  }

  p {
    margin-top: 0.3rem;
    font-size: 0.84rem;
    line-height: 1.55;
  }

  button {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    margin-top: 0.8rem;
    border: 0;
    background: transparent;
    color: var(--accent-text);
    cursor: pointer;
    font-size: 0.8rem;
    font-weight: 650;
  }
</style>
