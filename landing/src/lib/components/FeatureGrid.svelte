<script lang="ts">
  import { PRODUCT_CAPABILITIES } from "$lib/content.js";
</script>

<section id="capabilities" class="section" aria-labelledby="capabilities-title">
  <div class="section-heading">
    <p class="eyebrow">Built for shared intelligence</p>
    <h2 id="capabilities-title">
      One place for skills, context, and accountable change.
    </h2>
  </div>

  <div class="feature-grid">
    {#each PRODUCT_CAPABILITIES as feature (feature.title)}
      <article>
        <span class="icon"
          ><feature.icon size={20} weight="duotone" aria-hidden="true" /></span
        >
        <h3>{feature.title}</h3>
        <p>{feature.description}</p>
      </article>
    {/each}
  </div>
</section>

<style>
  .section {
    width: min(100% - 2rem, 75rem);
    margin: 0 auto;
    padding: 0 0 clamp(5rem, 10vw, 8rem);
  }

  .section-heading {
    max-width: 54rem;
    margin-bottom: var(--sp-space-10);
  }

  .eyebrow {
    margin: 0 0 var(--sp-space-4);
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

  .feature-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    border-top: 1px solid var(--sp-color-border);
    border-left: 1px solid var(--sp-color-border);
  }

  article {
    min-height: 16rem;
    border-right: 1px solid var(--sp-color-border);
    border-bottom: 1px solid var(--sp-color-border);
    padding: var(--sp-space-6);
    background: color-mix(in srgb, var(--sp-color-surface) 64%, transparent);
  }

  .icon {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface-raised);
    color: var(--sp-color-accent-text);
    box-shadow: var(--sp-shadow-sm);
  }

  h3 {
    margin: var(--sp-space-8) 0 var(--sp-space-3);
    font-size: var(--sp-font-size-5);
    font-weight: var(--sp-weight-semibold);
  }

  article p {
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: 1.65;
  }

  @media (max-width: 52rem) {
    .feature-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 36rem) {
    .feature-grid {
      grid-template-columns: 1fr;
    }

    article {
      min-height: 0;
    }
  }
</style>
