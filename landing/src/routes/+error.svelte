<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import {
    ArrowClockwiseIcon as ArrowClockwise,
    ArrowLeftIcon as ArrowLeft,
  } from "phosphor-svelte";
</script>

<svelte:head>
  <title
    >{page.status === 404 ? "Page not found" : "Page unavailable"} · Skillplane</title
  >
  <meta name="robots" content="noindex" />
</svelte:head>

<main id="main-content" class="error-page">
  <p class="status">{page.status}</p>
  <h1>
    {page.status === 404
      ? "That page could not be found."
      : "This page is unavailable."}
  </h1>
  <p class="message">
    {page.status === 404
      ? "The skill may be private, archived, renamed, or no longer published."
      : "Skillplane could not load this page. Retry the request or return home."}
  </p>
  <div class="actions">
    <button type="button" onclick={() => location.reload()}>
      <ArrowClockwise size={16} aria-hidden="true" /> Retry
    </button>
    <a href={resolve("/")}>
      <ArrowLeft size={16} aria-hidden="true" /> Return home
    </a>
  </div>
</main>

<style>
  .error-page {
    display: grid;
    width: min(100% - 2rem, 48rem);
    min-height: 60vh;
    place-content: center;
    margin: 0 auto;
    padding: var(--sp-space-16) 0;
    text-align: center;
  }

  .status {
    margin: 0 0 var(--sp-space-4);
    color: var(--sp-color-accent-text);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-semibold);
  }

  h1 {
    margin: 0;
    font-size: clamp(2.5rem, 8vw, 5rem);
    letter-spacing: -0.055em;
    line-height: 1;
    text-wrap: balance;
  }

  .message {
    max-width: 38rem;
    margin: var(--sp-space-5) auto 0;
    color: var(--sp-color-text-muted);
    line-height: 1.65;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--sp-space-3);
    margin-top: var(--sp-space-8);
  }

  button,
  a {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    gap: var(--sp-space-2);
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-space-4);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
    cursor: pointer;
  }
</style>
