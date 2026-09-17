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
    padding: var(--sp-space-8);
  }
</style>
