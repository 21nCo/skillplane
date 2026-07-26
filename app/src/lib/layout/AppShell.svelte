<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import {
    CommandMenu,
    ErrorState,
    Skeleton,
    applyAppearance,
    isDensity,
    isTheme,
    type CommandItem,
    type Density,
    type Theme,
  } from "@skillplane/ui";
  import { RobotIcon, SquaresFourIcon, UsersThreeIcon } from "phosphor-svelte";
  import { onMount, type Snippet } from "svelte";
  import { signOut, type BrowserSession } from "$lib/auth/client.js";
  import type { WorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import Sidebar from "./Sidebar.svelte";
  import Topbar from "./Topbar.svelte";

  let {
    session,
    workspaces,
    children,
  }: {
    session: BrowserSession;
    workspaces: WorkspaceStore;
    children: Snippet;
  } = $props();

  let navigationOpen = $state(false);
  let commandsOpen = $state(false);
  let theme = $state<Theme>("dark");
  let density = $state<Density>("compact");
  let initialized = $state(false);

  const commands: readonly CommandItem[] = [
    {
      id: "workspaces",
      label: "Open workspaces",
      group: "Navigate",
      keywords: ["organization", "workspace"],
      shortcut: "G W",
      icon: SquaresFourIcon,
      run: () => goto(resolve("/workspaces")),
    },
    {
      id: "members",
      label: "Manage members",
      group: "Navigate",
      keywords: ["invitations", "roles"],
      shortcut: "G M",
      icon: UsersThreeIcon,
      run: () => goto(resolve("/settings/members")),
    },
    {
      id: "agents",
      label: "Manage agent credentials",
      group: "Navigate",
      keywords: ["service principal", "tokens"],
      shortcut: "G A",
      icon: RobotIcon,
      run: () => goto(resolve("/settings/agents")),
    },
  ];

  async function leaveSession() {
    await signOut();
    await goto(resolve("/sign-in"));
  }

  function toggleTheme() {
    theme = theme === "dark" ? "light" : "dark";
    applyAppearance(theme, density);
  }

  async function loadWorkspaces() {
    await workspaces.load();
    initialized = true;
  }

  onMount(() => {
    const storedTheme = localStorage.getItem("skillplane.theme");
    const storedDensity = localStorage.getItem("skillplane.density");
    theme = isTheme(storedTheme) ? storedTheme : "dark";
    density = isDensity(storedDensity) ? storedDensity : "compact";
    applyAppearance(theme, density);
    void loadWorkspaces();
  });

  $effect(() => {
    if (!initialized || typeof page.params.workspaceSlug !== "string") return;
    const routed = workspaces.workspaces.find(
      (workspace) => workspace.slug === page.params.workspaceSlug,
    );
    if (routed && workspaces.activeId !== routed.id) {
      workspaces.select(routed.id);
    }
  });
</script>

{#if !initialized}
  <main class="boot" aria-label="Opening Skillplane" aria-busy="true">
    <div>
      <Skeleton width="2.25rem" height="2.25rem" radius="var(--sp-radius-lg)" />
      <Skeleton width="12rem" height="1rem" />
      <Skeleton width="18rem" height="0.75rem" />
    </div>
  </main>
{:else if workspaces.error}
  <main class="boot error">
    <ErrorState
      title="Skillplane did not open"
      description={workspaces.error}
      retry={() => void loadWorkspaces()}
    />
  </main>
{:else}
  <div class="shell">
    <Sidebar
      open={navigationOpen}
      pathname={page.url.pathname}
      store={workspaces}
      onClose={() => (navigationOpen = false)}
    />
    {#if navigationOpen}
      <button
        class="scrim"
        type="button"
        aria-label="Close navigation"
        onclick={() => (navigationOpen = false)}
      ></button>
    {/if}
    <div class="content" inert={navigationOpen ? true : undefined}>
      <Topbar
        {session}
        workspaceName={workspaces.active?.name ?? "Skillplane"}
        {theme}
        onOpenNavigation={() => (navigationOpen = true)}
        onOpenCommands={() => (commandsOpen = true)}
        onToggleTheme={toggleTheme}
        onSignOut={() => void leaveSession()}
      />
      <div class="page-content">{@render children()}</div>
    </div>
  </div>
  <CommandMenu {commands} bind:open={commandsOpen} />
{/if}

<style>
  .boot {
    display: grid;
    min-height: 100dvh;
    place-items: center;
    padding: var(--sp-space-4);
  }

  .boot > div {
    display: grid;
    justify-items: center;
    gap: var(--sp-space-3);
  }

  .boot.error {
    width: min(100%, 34rem);
    margin: auto;
  }

  .shell {
    display: grid;
    min-height: 100dvh;
    grid-template-columns: var(--sp-sidebar-width) minmax(0, 1fr);
  }

  .content {
    min-width: 0;
  }

  .page-content {
    min-width: 0;
  }

  .scrim {
    display: none;
  }

  @media (max-width: 47.999rem) {
    .shell {
      display: block;
    }

    .scrim {
      position: fixed;
      z-index: 25;
      inset: 0;
      display: block;
      border: 0;
      background: var(--sp-color-overlay);
      cursor: pointer;
    }
  }
</style>
