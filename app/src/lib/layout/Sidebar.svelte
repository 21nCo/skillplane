<script lang="ts">
  import {
    BookOpenTextIcon,
    ChartLineUpIcon,
    RobotIcon,
    ShieldCheckIcon,
    SquaresFourIcon,
    UsersThreeIcon,
    XIcon,
  } from "phosphor-svelte";
  import { resolve } from "$app/paths";
  import { IconButton } from "@skillplane/ui";
  import type { WorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import WorkspaceSwitcher from "./WorkspaceSwitcher.svelte";

  export interface NavigationItem {
    readonly href: string;
    readonly label: string;
    readonly icon: typeof SquaresFourIcon;
  }

  let {
    open,
    pathname,
    store,
    onClose,
  }: {
    open: boolean;
    pathname: string;
    store: WorkspaceStore;
    onClose: () => void;
  } = $props();

  const navigation = [
    { href: "/workspaces", label: "Workspaces", icon: SquaresFourIcon },
    { href: "/settings/members", label: "Members", icon: UsersThreeIcon },
    { href: "/settings/agents", label: "Agent credentials", icon: RobotIcon },
  ] as const satisfies readonly NavigationItem[];
</script>

<svelte:window
  onkeydown={(event) => {
    if (open && event.key === "Escape") onClose();
  }}
/>

<aside class:open aria-label="Application navigation">
  <div class="brand-row">
    <a class="brand" href={resolve("/workspaces")} aria-label="Skillplane workspaces">
      <span aria-hidden="true">S</span>
      <strong>Skillplane</strong>
    </a>
    <span class="mobile-close">
      <IconButton label="Close navigation" onclick={onClose}>
        <XIcon weight="bold" />
      </IconButton>
    </span>
  </div>

  <WorkspaceSwitcher {store} />

  <nav aria-label="Workspace">
    <p>Workspace</p>
    {#if store.active}
      {@const skillsHref = resolve("/(app)/[workspaceSlug]/skills", {
        workspaceSlug: store.active.slug,
      })}
      <a
        class:active={pathname === skillsHref || pathname.startsWith(`${skillsHref}/`)}
        href={skillsHref}
        aria-current={pathname === skillsHref ? "page" : undefined}
        onclick={onClose}
      >
        <BookOpenTextIcon weight="duotone" aria-hidden="true" />
        Skills
      </a>
      {@const analyticsHref = resolve("/(app)/[workspaceSlug]/analytics", {
        workspaceSlug: store.active.slug,
      })}
      <a
        class:active={pathname === analyticsHref}
        href={analyticsHref}
        aria-current={pathname === analyticsHref ? "page" : undefined}
        onclick={onClose}
      >
        <ChartLineUpIcon weight="duotone" aria-hidden="true" />
        Analytics
      </a>
      {#if store.active.role === "admin" || store.active.role === "owner"}
        {@const auditHref = resolve("/(app)/[workspaceSlug]/audit", {
          workspaceSlug: store.active.slug,
        })}
        <a
          class:active={pathname === auditHref}
          href={auditHref}
          aria-current={pathname === auditHref ? "page" : undefined}
          onclick={onClose}
        >
          <ShieldCheckIcon weight="duotone" aria-hidden="true" />
          Audit
        </a>
      {/if}
    {/if}
    {#each navigation as item (item.href)}
      <a
        class:active={pathname === item.href || pathname.startsWith(`${item.href}/`)}
        href={resolve(item.href)}
        aria-current={pathname === item.href ? "page" : undefined}
        onclick={onClose}
      >
        <item.icon weight="duotone" aria-hidden="true" />
        {item.label}
      </a>
    {/each}
  </nav>

  <div class="workspace-meta">
    <span class="avatar" aria-hidden="true">
      {(store.active?.name ?? "S").slice(0, 1).toLocaleUpperCase()}
    </span>
    <span>
      <strong>{store.active?.name ?? "Loading workspace"}</strong>
      <small>{store.active?.role ?? "member"}</small>
    </span>
  </div>
</aside>

<style>
  aside {
    position: sticky;
    z-index: 30;
    top: 0;
    display: flex;
    width: var(--sp-sidebar-width);
    height: 100dvh;
    flex-direction: column;
    border-right: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface);
  }

  .brand-row {
    display: flex;
    min-height: var(--sp-topbar-height);
    align-items: center;
    justify-content: space-between;
    padding: 0 var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .brand {
    display: inline-flex;
    gap: var(--sp-space-2);
    align-items: center;
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  .brand > span {
    display: grid;
    width: 1.625rem;
    height: 1.625rem;
    place-items: center;
    border: 1px solid var(--sp-color-accent);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
  }

  nav {
    display: grid;
    gap: 2px;
    padding: var(--sp-space-2);
  }

  nav p {
    margin: var(--sp-space-2) var(--sp-space-2) var(--sp-space-1);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  nav a {
    display: flex;
    min-height: 2rem;
    align-items: center;
    gap: var(--sp-space-2);
    border-radius: var(--sp-radius-md);
    padding: 0 var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
    text-decoration: none;
  }

  nav a:hover,
  nav a.active {
    background: var(--sp-color-surface-hover);
    color: var(--sp-color-text);
  }

  nav a.active {
    box-shadow: inset 2px 0 var(--sp-color-accent);
  }

  nav a :global(svg) {
    width: var(--sp-icon-md);
    height: var(--sp-icon-md);
  }

  .workspace-meta {
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-2);
    align-items: center;
    margin-top: auto;
    padding: var(--sp-space-3);
    border-top: 1px solid var(--sp-color-border);
  }

  .avatar {
    display: grid;
    width: 1.75rem;
    height: 1.75rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
  }

  .workspace-meta > span:last-child,
  .workspace-meta strong,
  .workspace-meta small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-meta strong {
    font-size: var(--sp-font-size-2);
  }

  .workspace-meta small {
    margin-top: 2px;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    text-transform: capitalize;
  }

  .mobile-close {
    display: none;
  }

  @media (max-width: 47.999rem) {
    aside {
      position: fixed;
      left: 0;
      transform: translateX(-100%);
      transition: transform var(--sp-duration-normal) var(--sp-ease-standard);
    }

    aside.open {
      transform: translateX(0);
    }

    .mobile-close {
      display: inline-flex;
    }
  }
</style>
