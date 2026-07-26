<script lang="ts">
  import { ArrowRightIcon as ArrowRight } from "phosphor-svelte";
  import { WORKFLOW_STEPS } from "$lib/content.js";
</script>

<section id="workflow" class="section" aria-labelledby="workflow-title">
  <div class="section-heading">
    <p class="eyebrow">A controlled learning loop</p>
    <h2 id="workflow-title">From human knowledge to agent learning—and back.</h2>
    <p>
      The published skill stays stable while agents use it. New learning enters as a
      candidate with evidence and a review trail.
    </p>
  </div>

  <ol class="workflow-list">
    {#each WORKFLOW_STEPS as step, index (step.number)}
      <li>
        <span class="number">{step.number}</span>
        <div>
          <h3>{step.title}</h3>
          <p>{step.description}</p>
        </div>
        {#if index < WORKFLOW_STEPS.length - 1}
          <ArrowRight class="arrow" size={16} aria-hidden="true" />
        {/if}
      </li>
    {/each}
  </ol>
</section>

<style>
  .section {
    width: min(100% - 2rem, 75rem);
    margin: 0 auto;
    padding: clamp(5rem, 10vw, 8rem) 0;
  }

  .section-heading {
    display: grid;
    grid-template-columns: 1fr 2fr;
    gap: var(--sp-space-6);
    align-items: start;
    margin-bottom: var(--sp-space-12);
  }

  .eyebrow {
    margin: 0;
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h2 {
    margin: 0;
    font-size: clamp(2rem, 5vw, 3.6rem);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: -0.05em;
    line-height: 1.05;
    text-wrap: balance;
  }

  .section-heading > p:last-child {
    grid-column: 2;
    max-width: 42rem;
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-5);
    line-height: 1.65;
  }

  .workflow-list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    margin: 0;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-xl);
    padding: 0;
    overflow: hidden;
    background: var(--sp-color-surface);
    list-style: none;
  }

  li {
    position: relative;
    display: grid;
    grid-template-columns: auto 1fr;
    gap: var(--sp-space-4);
    min-height: 12rem;
    padding: var(--sp-space-6);
    border-right: 1px solid var(--sp-color-border);
    border-bottom: 1px solid var(--sp-color-border);
  }

  li:nth-child(3n) {
    border-right: 0;
  }

  li:nth-last-child(-n + 3) {
    border-bottom: 0;
  }

  .number {
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
  }

  h3 {
    margin: 0 0 var(--sp-space-3);
    font-size: var(--sp-font-size-5);
    font-weight: var(--sp-weight-semibold);
  }

  li p {
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: 1.6;
  }

  li :global(.arrow) {
    position: absolute;
    z-index: 1;
    right: -0.5rem;
    bottom: -0.5rem;
    padding: 0.15rem;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-round);
    background: var(--sp-color-canvas);
    color: var(--sp-color-text-subtle);
  }

  @media (max-width: 54rem) {
    .workflow-list {
      grid-template-columns: repeat(2, 1fr);
    }

    li,
    li:nth-child(3n) {
      border-right: 1px solid var(--sp-color-border);
      border-bottom: 1px solid var(--sp-color-border);
    }

    li:nth-child(2n) {
      border-right: 0;
    }

    li:nth-last-child(-n + 2) {
      border-bottom: 0;
    }
  }

  @media (max-width: 40rem) {
    .section-heading {
      grid-template-columns: 1fr;
    }

    .section-heading > p:last-child {
      grid-column: 1;
    }

    .workflow-list {
      grid-template-columns: 1fr;
    }

    li,
    li:nth-child(2n),
    li:nth-child(3n),
    li:nth-last-child(-n + 2) {
      min-height: 0;
      border-right: 0;
      border-bottom: 1px solid var(--sp-color-border);
    }

    li:last-child {
      border-bottom: 0;
    }
  }
</style>
