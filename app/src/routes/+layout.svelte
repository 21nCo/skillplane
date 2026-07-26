<script lang="ts">
  import "@skillplane/ui/styles/tailwind.css";

  let { children } = $props();
</script>

<svelte:head>
  <title>Skillplane</title>
  <meta
    name="description"
    content="Manage reusable, versioned AI skills with context-aware knowledge and complete provenance."
  />
</svelte:head>

{@render children()}
