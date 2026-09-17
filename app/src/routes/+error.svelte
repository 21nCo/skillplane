<script lang="ts">
  import { page } from "$app/state";
  import { ErrorState } from "@skillplane/ui";

  function retry() {
    window.location.reload();
  }
</script>

<svelte:head>
  <title>Request failed · Skillplane</title>
</svelte:head>

<main>
  <p class="status">{page.status}</p>
  <ErrorState
    title="The page could not be rendered."
    description={page.error?.message ?? "An unexpected application error occurred."}
    {retry}
  />
</main>

<style>
  main {
    display: grid;
    min-height: 100vh;
    place-content: center;
    justify-items: center;
    padding: var(--sp-space-8);
  }

  .status {
    margin: 0 0 var(--sp-space-3);
    color: var(--sp-color-accent);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-3);
  }
</style>
