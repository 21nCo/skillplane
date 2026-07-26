<script lang="ts">
  import { resolve } from "$app/paths";
  import {
    MagnifyingGlassIcon as MagnifyingGlass,
    StackIcon as Stack,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";
  import PublicSkillCard from "$lib/components/PublicSkillCard.svelte";
  import { SITE_ORIGIN } from "$lib/content.js";
  import type { ApiEnvelope, ApiFailure, PublicSkillPage } from "$lib/public-skills.js";
  import type { PageData } from "./$types";
  import { onMount } from "svelte";
  import { SvelteURLSearchParams } from "svelte/reactivity";

  let { data }: { data: PageData } = $props();
  // svelte-ignore state_referenced_locally
  let query = $state(data.query);
  // svelte-ignore state_referenced_locally
  let skills = $state([...data.page.skills]);
  // svelte-ignore state_referenced_locally
  let nextCursor = $state(data.page.nextCursor);
  // svelte-ignore state_referenced_locally
  let errorMessage = $state<string | null>(data.error);
  let loading = $state(false);
  let loadingMore = $state(false);
  let hydrated = $state(false);

  onMount(() => {
    hydrated = true;
  });

  async function requestPage(cursor: string | null = null): Promise<PublicSkillPage> {
    const parameters = new SvelteURLSearchParams({ limit: "12" });
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized) parameters.set("q", normalized);
    if (cursor) parameters.set("cursor", cursor);
    const response = await fetch(`/api/public-skills?${parameters.toString()}`, {
      headers: { accept: "application/json" },
    });
    const envelope = (await response.json()) as
      ApiEnvelope<PublicSkillPage> | ApiFailure;
    if (!response.ok || !envelope.ok) {
      throw new Error(
        !envelope.ok
          ? envelope.error.message
          : "Public skill discovery is temporarily unavailable.",
      );
    }
    return envelope.data;
  }

  async function search(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const normalized = query.trim().replace(/\s+/g, " ");
    if (normalized.length > 500) {
      errorMessage = "Search terms must be 500 characters or fewer.";
      return;
    }
    loading = true;
    errorMessage = null;
    try {
      const result = await requestPage();
      skills = [...result.skills];
      nextCursor = result.nextCursor;
      const location = new URL(window.location.href);
      if (normalized) location.searchParams.set("q", normalized);
      else location.searchParams.delete("q");
      history.replaceState(history.state, "", location);
    } catch (caught) {
      errorMessage =
        caught instanceof Error
          ? caught.message
          : "Public skill discovery is temporarily unavailable.";
    } finally {
      loading = false;
    }
  }

  async function loadMore(): Promise<void> {
    if (!nextCursor || loadingMore) return;
    loadingMore = true;
    errorMessage = null;
    try {
      const result = await requestPage(nextCursor);
      skills = [...skills, ...result.skills];
      nextCursor = result.nextCursor;
    } catch (caught) {
      errorMessage =
        caught instanceof Error ? caught.message : "More skills could not be loaded.";
    } finally {
      loadingMore = false;
    }
  }
</script>

<svelte:head>
  <title>Explore public AI skills · Skillplane</title>
  <link rel="canonical" href={`${SITE_ORIGIN}/skills`} />
  <meta
    name="description"
    content="Search published, versioned AI skills shared by Skillplane workspaces."
  />
  <meta property="og:title" content="Explore public AI skills · Skillplane" />
  <meta
    property="og:description"
    content="Search published, versioned AI skills shared by Skillplane workspaces."
  />
  <meta property="og:url" content={`${SITE_ORIGIN}/skills`} />
  <meta name="twitter:title" content="Explore public AI skills · Skillplane" />
  <meta
    name="twitter:description"
    content="Search published, versioned AI skills shared by Skillplane workspaces."
  />
</svelte:head>

<main id="main-content" class="directory">
  <header class="directory-header">
    <p class="eyebrow">Public skills</p>
    <h1>Discover skills built to be reused.</h1>
    <p>
      Search published skill instructions and metadata. Candidate versions, context
      knowledge, and agent notes never appear here.
    </p>
    <form role="search" data-hydrated={hydrated} onsubmit={search}>
      <label for="skill-search">Search published skills</label>
      <div class="search-control">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <input
          id="skill-search"
          name="q"
          bind:value={query}
          maxlength="500"
          placeholder="Try “pull request review”"
          autocomplete="off"
        />
        <button type="submit" disabled={loading}>
          {loading ? "Searching…" : "Search"}
        </button>
      </div>
    </form>
  </header>

  <section class="results" aria-labelledby="results-title" aria-busy={loading}>
    <div class="results-heading">
      <h2 id="results-title">
        {query.trim() ? `Results for “${query.trim()}”` : "Recently updated"}
      </h2>
      <p aria-live="polite">
        {loading
          ? "Searching published skills"
          : `${skills.length.toString()} ${
              skills.length === 1 ? "skill" : "skills"
            } shown`}
      </p>
    </div>

    {#if errorMessage}
      <div class="state error-state" role="alert">
        <WarningCircle size={28} weight="duotone" aria-hidden="true" />
        <h2>Skills could not be loaded.</h2>
        <p>{errorMessage}</p>
        <button type="button" onclick={() => search(new SubmitEvent("submit"))}>
          Retry
        </button>
      </div>
    {:else if loading}
      <div class="skill-grid" aria-label="Loading skills">
        {#each [0, 1, 2, 3, 4, 5] as index (index)}
          <div class="skeleton-card" aria-hidden="true">
            <span></span><span></span><span></span><span></span>
          </div>
        {/each}
      </div>
    {:else if skills.length === 0}
      <div class="state empty-state">
        <Stack size={30} weight="duotone" aria-hidden="true" />
        <h2>
          {query.trim()
            ? "No published skills match that search."
            : "No public skills yet."}
        </h2>
        <p>
          {query.trim()
            ? "Try fewer terms or browse all published skills."
            : "Published public skills will appear here once they are available."}
        </p>
        {#if query.trim()}
          <a href={resolve("/skills")}>Clear search</a>
        {/if}
      </div>
    {:else}
      <div class="skill-grid" data-testid="public-skill-grid">
        {#each skills as skill (skill.id)}
          <PublicSkillCard {skill} />
        {/each}
      </div>
      {#if nextCursor}
        <div class="load-more">
          <button type="button" disabled={loadingMore} onclick={loadMore}>
            {loadingMore ? "Loading…" : "Load more skills"}
          </button>
        </div>
      {/if}
    {/if}
  </section>
</main>

<style>
  .directory {
    width: min(100% - 2rem, 75rem);
    margin: 0 auto;
    padding: clamp(4rem, 9vw, 7rem) 0;
  }

  .directory-header {
    max-width: 52rem;
    margin: 0 auto;
    text-align: center;
  }

  .eyebrow {
    margin: 0 0 var(--sp-space-4);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.75rem, 7vw, 5.25rem);
    letter-spacing: -0.06em;
    line-height: 0.98;
    text-wrap: balance;
  }

  .directory-header > p:not(.eyebrow) {
    max-width: 43rem;
    margin: var(--sp-space-5) auto 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-5);
    line-height: 1.65;
  }

  form {
    margin-top: var(--sp-space-8);
    text-align: left;
  }

  label {
    display: block;
    margin-bottom: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
  }

  .search-control {
    display: grid;
    grid-template-columns: auto 1fr auto;
    gap: var(--sp-space-3);
    align-items: center;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-2);
    padding-left: var(--sp-space-4);
    background: var(--sp-color-surface);
    box-shadow: var(--sp-shadow-md);
  }

  .search-control :global(svg) {
    color: var(--sp-color-text-subtle);
  }

  input {
    min-width: 0;
    height: 2.5rem;
    border: 0;
    background: transparent;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-4);
  }

  input::placeholder {
    color: var(--sp-color-text-subtle);
  }

  .search-control button,
  .load-more button,
  .state button,
  .state a {
    display: inline-flex;
    min-height: 2.5rem;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-space-4);
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
    cursor: pointer;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.64;
  }

  .results {
    margin-top: clamp(4rem, 8vw, 6rem);
  }

  .results-heading {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--sp-space-4);
    margin-bottom: var(--sp-space-5);
    border-bottom: 1px solid var(--sp-color-border);
    padding-bottom: var(--sp-space-4);
  }

  .results-heading h2 {
    margin: 0;
    font-size: var(--sp-font-size-5);
  }

  .results-heading p {
    margin: 0;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .skill-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-space-4);
  }

  .skeleton-card {
    display: grid;
    min-height: 19rem;
    align-content: start;
    gap: var(--sp-space-4);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
  }

  .skeleton-card span {
    height: 1rem;
    border-radius: var(--sp-radius-sm);
    background: var(--sp-color-skeleton);
    animation: pulse 1.2s ease-in-out infinite alternate;
  }

  .skeleton-card span:first-child {
    width: 2.5rem;
    height: 2.5rem;
  }

  .skeleton-card span:nth-child(2) {
    width: 55%;
    margin-top: var(--sp-space-5);
  }

  .skeleton-card span:nth-child(3) {
    width: 92%;
  }

  .skeleton-card span:last-child {
    width: 70%;
  }

  @keyframes pulse {
    to {
      opacity: 0.45;
    }
  }

  .state {
    display: grid;
    min-height: 22rem;
    place-items: center;
    align-content: center;
    border: 1px dashed var(--sp-color-border-strong);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-8);
    text-align: center;
  }

  .state :global(svg) {
    color: var(--sp-color-accent-text);
  }

  .state h2 {
    margin: var(--sp-space-4) 0 var(--sp-space-2);
    font-size: var(--sp-font-size-6);
  }

  .state p {
    max-width: 32rem;
    margin: 0 0 var(--sp-space-5);
    color: var(--sp-color-text-muted);
    line-height: 1.6;
  }

  .error-state :global(svg) {
    color: var(--sp-color-danger);
  }

  .load-more {
    display: flex;
    justify-content: center;
    margin-top: var(--sp-space-8);
  }

  .load-more button {
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
  }

  @media (max-width: 58rem) {
    .skill-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }

  @media (max-width: 38rem) {
    .directory {
      padding-top: 3.5rem;
    }

    .search-control {
      grid-template-columns: auto 1fr;
    }

    .search-control button {
      grid-column: 1 / -1;
      width: 100%;
    }

    .results-heading {
      align-items: flex-start;
      flex-direction: column;
    }

    .skill-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
