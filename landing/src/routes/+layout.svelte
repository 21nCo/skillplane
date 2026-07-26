<script lang="ts">
  import "@skillplane/ui/styles/tailwind.css";
  import Footer from "$lib/components/Footer.svelte";
  import SiteHeader from "$lib/components/SiteHeader.svelte";
  import { SITE_ORIGIN } from "$lib/content.js";

  let { children } = $props();
</script>

<svelte:head>
  <meta
    name="description"
    content="Create, version, retrieve, and improve reusable AI skills with context-aware knowledge and complete provenance."
  />
  <meta name="application-name" content="Skillplane" />
  <meta name="author" content="Skillplane" />
  <meta property="og:site_name" content="Skillplane" />
  <meta property="og:type" content="website" />
  <meta property="og:image" content={`${SITE_ORIGIN}/social-card.svg`} />
  <meta property="og:image:width" content="1200" />
  <meta property="og:image:height" content="630" />
  <meta
    property="og:image:alt"
    content="Skillplane — versioned skills for accountable AI agents"
  />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content={`${SITE_ORIGIN}/social-card.svg`} />
</svelte:head>

<a class="skip-link" href="#main-content">Skip to main content</a>
<SiteHeader />
{@render children()}
<Footer />

<style>
  :global(html) {
    scroll-behavior: smooth;
  }

  :global(body) {
    overflow-x: hidden;
  }

  :global(a) {
    text-underline-offset: 0.18em;
  }

  .skip-link {
    position: fixed;
    z-index: 100;
    top: var(--sp-space-3);
    left: var(--sp-space-3);
    transform: translateY(-200%);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3) var(--sp-space-4);
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
  }

  .skip-link:focus {
    transform: translateY(0);
  }
</style>
