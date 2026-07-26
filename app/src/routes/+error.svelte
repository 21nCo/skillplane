<script lang="ts">
  import { page } from "$app/state";

  function retry() {
    window.location.reload();
  }
</script>

<svelte:head>
  <title>Request failed · Skillplane</title>
</svelte:head>

<main role="alert">
  <p class="code">{page.status}</p>
  <h1>The page could not be rendered.</h1>
  <p>{page.error?.message ?? "An unexpected application error occurred."}</p>
  <button type="button" onclick={retry}>Try again</button>
</main>

<style>
  main {
    display: grid;
    min-height: 100vh;
    place-content: center;
    padding: 2rem;
    text-align: center;
  }

  .code {
    margin: 0;
    color: var(--sp-color-accent);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }

  h1 {
    margin: 0.75rem 0;
    font-size: clamp(1.8rem, 5vw, 3.5rem);
    letter-spacing: -0.045em;
  }

  p {
    color: var(--sp-color-text-muted);
  }

  button {
    justify-self: center;
    margin-top: 1rem;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: 0.55rem;
    padding: 0.65rem 0.9rem;
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    cursor: pointer;
  }
</style>
