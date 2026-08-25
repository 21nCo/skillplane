<script lang="ts">
  import { initializePostHog } from "$lib/analytics/posthog.client";
  import "@skillplane/ui/styles/tailwind.css";
  import { onMount } from "svelte";

  let { children } = $props();

  onMount(() => {
    void initializePostHog();
  });
</script>

<svelte:head>
  <title>Skillplane</title>
  <meta
    name="description"
    content="Manage reusable, versioned AI skills with context-aware knowledge and complete provenance."
  />
</svelte:head>

{@render children()}
