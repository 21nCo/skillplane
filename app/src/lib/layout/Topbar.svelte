<script lang="ts">
  import { CommandIcon, ListIcon, MoonIcon, SunIcon } from "phosphor-svelte";
  import { Button, Dropdown, IconButton, type DropdownItem } from "@skillplane/ui";
  import type { BrowserSession } from "$lib/auth/client.js";
  import type { Theme } from "@skillplane/ui";

  let {
    session,
    workspaceName,
    theme,
    onOpenNavigation,
    onOpenCommands,
    onToggleTheme,
    onSignOut,
  }: {
    session: BrowserSession;
    workspaceName: string;
    theme: Theme;
    onOpenNavigation: () => void;
    onOpenCommands: () => void;
    onToggleTheme: () => void;
    onSignOut: () => void;
  } = $props();

  const accountItems = $derived([
    {
      id: "identity",
      label: session.subject.email ?? "Signed-in user",
      description: "Current account",
      disabled: true,
    },
    {
      id: "sign-out",
      label: "Sign out",
      description: "End this browser session",
    },
  ] as const satisfies readonly DropdownItem[]);
</script>

<header>
  <div class="mobile-menu">
    <IconButton label="Open navigation" onclick={onOpenNavigation}>
      <ListIcon weight="bold" />
    </IconButton>
  </div>
  <div class="title">
    <span>Workspace</span>
    <strong>{workspaceName}</strong>
  </div>
  <div class="actions">
    <Button
      variant="ghost"
      size="sm"
      onclick={onOpenCommands}
      aria-label="Open command menu"
      aria-keyshortcuts="Control+K Meta+K"
    >
      {#snippet leading()}<CommandIcon size={14} weight="bold" />{/snippet}
      <span class="command-label">Commands</span>
      {#snippet trailing()}<kbd>⌘K</kbd>{/snippet}
    </Button>
    <IconButton
      label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
      onclick={onToggleTheme}
    >
      {#if theme === "dark"}<SunIcon weight="bold" />{:else}<MoonIcon
          weight="bold"
        />{/if}
    </IconButton>
    <Dropdown
      label="Account"
      items={accountItems}
      align="end"
      onSelect={(item) => {
        if (item.id === "sign-out") onSignOut();
      }}
    />
  </div>
</header>

<style>
  header {
    position: sticky;
    z-index: 20;
    top: 0;
    display: flex;
    min-height: var(--sp-topbar-height);
    align-items: center;
    gap: var(--sp-space-3);
    justify-content: space-between;
    padding: 0 var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
    background: color-mix(in srgb, var(--sp-color-canvas) 90%, transparent);
    backdrop-filter: blur(14px);
  }

  .title span,
  .title strong {
    display: block;
  }

  .title span {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .title strong {
    margin-top: 1px;
    font-size: var(--sp-font-size-3);
  }

  .actions {
    display: flex;
    align-items: center;
    gap: var(--sp-space-1);
  }

  kbd {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-sm);
    padding: 1px var(--sp-space-1);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-sans);
    font-size: var(--sp-font-size-1);
  }

  .mobile-menu {
    display: none;
  }

  @media (max-width: 47.999rem) {
    header {
      padding: 0 var(--sp-space-3);
    }

    .mobile-menu {
      display: block;
    }

    .title {
      min-width: 0;
      margin-right: auto;
    }

    .title strong {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .command-label,
    kbd {
      display: none;
    }
  }
</style>
