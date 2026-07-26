<script lang="ts">
  import FeatureGrid from "$lib/components/FeatureGrid.svelte";
  import Hero from "$lib/components/Hero.svelte";
  import Security from "$lib/components/Security.svelte";
  import Workflow from "$lib/components/Workflow.svelte";
  import { SITE_ORIGIN } from "$lib/content.js";
</script>

<svelte:head>
  <title>Skillplane · Versioned skills for accountable AI agents</title>
  <link rel="canonical" href={`${SITE_ORIGIN}/`} />
  <meta
    name="description"
    content="Create reusable AI skills, add project context, and let agents propose evidence-backed improvements through MCP."
  />
  <meta
    property="og:title"
    content="Skillplane · Versioned skills for accountable AI agents"
  />
  <meta
    property="og:description"
    content="Create reusable AI skills, add project context, and control how agents improve them."
  />
  <meta property="og:url" content={`${SITE_ORIGIN}/`} />
  <meta
    name="twitter:title"
    content="Skillplane · Versioned skills for accountable AI agents"
  />
  <meta
    name="twitter:description"
    content="Create reusable AI skills, add project context, and control how agents improve them."
  />
</svelte:head>

<main id="main-content">
  <Hero />
  <Workflow />
  <FeatureGrid />
  <Security />
</main>
