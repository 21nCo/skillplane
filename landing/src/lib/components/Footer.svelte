<script lang="ts">
  import { resolve } from "$app/paths";
  import { ArrowRightIcon as ArrowRight, StackIcon as Stack } from "phosphor-svelte";
  import { PRIMARY_NAVIGATION } from "$lib/content.js";
</script>

<footer>
  <div class="cta">
    <div>
      <p>Put your agents on a learning plane.</p>
      <h2>Create the skill once. Improve it with every project.</h2>
    </div>
    <a href="https://app.skillplane.dev/sign-in?intent=signup">
      Create account <ArrowRight size={16} aria-hidden="true" />
    </a>
  </div>
  <div class="footer-row">
    <a class="brand" href={resolve("/")} aria-label="Skillplane home">
      <span aria-hidden="true"><Stack size={15} weight="fill" /></span>
      Skillplane
    </a>
    <nav aria-label="Footer navigation">
      {#each PRIMARY_NAVIGATION as item (item.href)}
        <a href={resolve(item.href)}>{item.label}</a>
      {/each}
      <a href="https://app.skillplane.dev/sign-in">Sign in</a>
    </nav>
    <p>Versioned skills for accountable agents.</p>
  </div>
</footer>

<style>
  footer {
    width: min(100% - 2rem, 75rem);
    margin: 0 auto;
    padding: clamp(5rem, 10vw, 8rem) 0 var(--sp-space-8);
  }

  .cta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-8);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-xl);
    padding: clamp(1.5rem, 5vw, 3.5rem);
    background:
      linear-gradient(
        120deg,
        color-mix(in srgb, var(--sp-color-accent-soft) 70%, transparent),
        transparent 58%
      ),
      var(--sp-color-surface);
  }

  .cta p {
    margin: 0 0 var(--sp-space-3);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h2 {
    max-width: 42rem;
    margin: 0;
    font-size: clamp(1.7rem, 4vw, 3rem);
    letter-spacing: -0.04em;
    line-height: 1.1;
    text-wrap: balance;
  }

  .cta > a {
    display: inline-flex;
    min-height: 2.75rem;
    flex: 0 0 auto;
    align-items: center;
    gap: var(--sp-space-2);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-space-5);
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
    font-size: var(--sp-font-size-4);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
  }

  .footer-row {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--sp-space-8);
    align-items: center;
    padding-top: var(--sp-space-10);
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-4);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
  }

  .brand span {
    display: grid;
    width: 1.6rem;
    height: 1.6rem;
    place-items: center;
    border-radius: var(--sp-radius-sm);
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
  }

  nav {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--sp-space-5);
  }

  nav a,
  .footer-row > p {
    margin: 0;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    text-decoration: none;
  }

  nav a:hover {
    color: var(--sp-color-text);
  }

  @media (max-width: 48rem) {
    .cta {
      align-items: flex-start;
      flex-direction: column;
    }

    .footer-row {
      grid-template-columns: 1fr;
    }

    nav {
      justify-content: flex-start;
    }
  }
</style>
