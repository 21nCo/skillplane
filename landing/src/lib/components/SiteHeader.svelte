<script lang="ts">
  import { resolve } from "$app/paths";
  import {
    applyAppearance,
    BrandMark,
    isTheme,
    THEME_STORAGE_KEY,
    type Theme,
  } from "@skillplane/ui";
  import {
    ListIcon as List,
    MoonIcon as Moon,
    SunIcon as Sun,
    XIcon as X,
  } from "phosphor-svelte";
  import { onMount } from "svelte";
  import { PRIMARY_NAVIGATION } from "$lib/content.js";

  let theme: Theme = "dark";
  let menuOpen = false;
  let hydrated = false;

  onMount(() => {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    const preferred = matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
    theme = isTheme(stored) ? stored : preferred;
    applyAppearance(theme, "comfortable");
    hydrated = true;
  });

  function toggleTheme(): void {
    theme = theme === "dark" ? "light" : "dark";
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    applyAppearance(theme, "comfortable");
  }

  function handleKeydown(event: KeyboardEvent): void {
    if (event.key === "Escape" && menuOpen) {
      menuOpen = false;
      document.querySelector<HTMLButtonElement>(".menu-button")?.focus();
    }
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<header class="site-header">
  <div class="header-inner">
    <a class="brand" href={resolve("/")} aria-label="Skillplane home">
      <BrandMark size="1.8rem" radius="0.45rem" />
      <span>Skillplane</span>
    </a>

    <nav class="desktop-nav" aria-label="Primary navigation">
      {#each PRIMARY_NAVIGATION as item (item.href)}
        <a href={resolve(item.href)}>{item.label}</a>
      {/each}
    </nav>

    <div class="header-actions">
      <button
        class="icon-button"
        type="button"
        aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
        data-hydrated={hydrated}
        onclick={toggleTheme}
      >
        {#if theme === "dark"}
          <Sun size={17} aria-hidden="true" />
        {:else}
          <Moon size={17} aria-hidden="true" />
        {/if}
      </button>
      <a class="sign-in" href="https://app.skillplane.dev/sign-in">Sign in</a>
      <a class="create-account" href="https://app.skillplane.dev/sign-in?intent=signup">
        Create account
      </a>
      <button
        class="menu-button"
        type="button"
        aria-label={menuOpen ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={menuOpen}
        aria-controls="mobile-navigation"
        data-hydrated={hydrated}
        onclick={() => (menuOpen = !menuOpen)}
      >
        {#if menuOpen}
          <X size={19} aria-hidden="true" />
        {:else}
          <List size={19} aria-hidden="true" />
        {/if}
      </button>
    </div>
  </div>

  {#if menuOpen}
    <nav id="mobile-navigation" class="mobile-nav" aria-label="Mobile navigation">
      {#each PRIMARY_NAVIGATION as item (item.href)}
        <a href={resolve(item.href)} onclick={() => (menuOpen = false)}>
          {item.label}
        </a>
      {/each}
      <a href="https://app.skillplane.dev/sign-in">Sign in</a>
      <a class="mobile-primary" href="https://app.skillplane.dev/sign-in?intent=signup">
        Create account
      </a>
    </nav>
  {/if}
</header>

<style>
  .site-header {
    position: sticky;
    z-index: 30;
    top: 0;
    border-bottom: 1px solid color-mix(in srgb, var(--sp-color-border) 82%, transparent);
    background: color-mix(in srgb, var(--sp-color-canvas) 88%, transparent);
    backdrop-filter: blur(16px);
  }

  .header-inner {
    display: flex;
    width: min(100% - 2rem, 75rem);
    min-height: 3.75rem;
    align-items: center;
    justify-content: space-between;
    margin: 0 auto;
  }

  .brand {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-4);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: -0.01em;
    text-decoration: none;
  }

  .desktop-nav {
    display: flex;
    align-items: center;
    gap: var(--sp-space-6);
  }

  .desktop-nav a,
  .sign-in {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
    text-decoration: none;
    transition: color var(--sp-duration-fast) var(--sp-ease-standard);
  }

  .desktop-nav a:hover,
  .sign-in:hover {
    color: var(--sp-color-text);
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: var(--sp-space-3);
  }

  .icon-button,
  .menu-button {
    display: inline-grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface);
    color: var(--sp-color-text-muted);
    cursor: pointer;
  }

  .create-account,
  .mobile-primary {
    border-radius: var(--sp-radius-md);
    padding: 0.48rem 0.75rem;
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
  }

  .menu-button {
    display: none;
  }

  .mobile-nav {
    display: grid;
    gap: var(--sp-space-1);
    border-top: 1px solid var(--sp-color-border);
    padding: var(--sp-space-3) var(--sp-space-4) var(--sp-space-4);
    background: var(--sp-color-canvas);
  }

  .mobile-nav a {
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-4);
    text-decoration: none;
  }

  .mobile-nav a:hover {
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text);
  }

  .mobile-nav .mobile-primary {
    margin-top: var(--sp-space-2);
    background: var(--sp-color-text);
    color: var(--sp-color-canvas);
    text-align: center;
  }

  @media (max-width: 52rem) {
    .desktop-nav,
    .sign-in,
    .create-account {
      display: none;
    }

    .menu-button {
      display: inline-grid;
    }
  }
</style>
