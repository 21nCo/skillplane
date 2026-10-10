<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { Badge, Button } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { provideSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowLeftIcon, ArchiveIcon, GlobeHemisphereWestIcon } from "phosphor-svelte";
  import type { Snippet } from "svelte";
  import type { LayoutData } from "./$types";

  let {
    data,
    children,
  }: {
    data: LayoutData;
    children: Snippet;
  } = $props();
  const workspaces = useWorkspaceStore();
  const detail = provideSkillDetailStore();
  const workspace = $derived(
    workspaces.workspaces.find((candidate) => candidate.slug === data.workspaceSlug) ??
      null,
  );
  const navigation = $derived(
    workspace
      ? [
          {
            label: "Overview",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
          {
            label: "Content",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/content", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
          {
            label: "Contexts",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/contexts", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
          {
            label: "Candidates",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/candidates", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
          {
            label: "Versions",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/versions", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
          {
            label: "Analytics",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/analytics", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
          ...(workspace.role === "admin" || workspace.role === "owner"
            ? [
                {
                  label: "Audit",
                  href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/audit", {
                    workspaceSlug: workspace.slug,
                    skillSlug: data.skillSlug,
                  }),
                },
              ]
            : []),
          {
            label: "Settings",
            href: resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/settings", {
              workspaceSlug: workspace.slug,
              skillSlug: data.skillSlug,
            }),
          },
        ]
      : [],
  );

  $effect(() => {
    if (workspace) void detail.load(workspace.id, data.skillSlug);
  });

  function isActive(href: string): boolean {
    if (href.endsWith(`/${data.skillSlug}`)) {
      return page.url.pathname === href;
    }
    return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  }
</script>

{#if detail.loading}
  <main class="detail-page">
    <SkillState
      kind="loading"
      title="Loading skill"
      message="Loading immutable versions and metadata."
    />
  </main>
{:else if detail.error !== null || !detail.skill || !workspace}
  <main class="detail-page">
    <SkillState
      kind="error"
      title="Skill could not be loaded"
      message={detail.error ?? "The skill does not exist or access was removed."}
      retry={() => workspace && void detail.load(workspace.id, data.skillSlug, true)}
    />
  </main>
{:else}
  <div class="detail-page">
    <a
      class="back"
      href={resolve("/(app)/[workspaceSlug]/skills", {
        workspaceSlug: workspace.slug,
      })}
    >
      <ArrowLeftIcon weight="bold" aria-hidden="true" /> Skills
    </a>

    <header class="skill-heading">
      <div class="skill-mark" aria-hidden="true">
        {#if detail.skill.archivedAt}
          <ArchiveIcon weight="duotone" />
        {:else}
          {detail.skill.name.slice(0, 1).toLocaleUpperCase()}
        {/if}
      </div>
      <div>
        <div class="title-row">
          <h1>{detail.skill.name}</h1>
          <Badge tone={detail.skill.archivedAt ? "warning" : "success"}>
            {detail.skill.archivedAt ? "Archived" : "Active"}
          </Badge>
          <Badge tone="neutral">{detail.skill.visibility}</Badge>
        </div>
        <p>{detail.skill.description || "No description provided."}</p>
        <div class="meta">
          <code>{detail.skill.slug}</code>
          <span>v{detail.skill.currentSemanticVersion ?? "unpublished"}</span>
          <span>{detail.versions.length} immutable versions</span>
        </div>
      </div>
      {#if detail.skill.visibility === "public" && !detail.skill.archivedAt}
        <Button
          variant="secondary"
          size="sm"
          href={resolve("/skills/[workspaceSlug]/[skillSlug]", {
            workspaceSlug: workspace.slug,
            skillSlug: detail.skill.slug,
          })}
        >
          {#snippet leading()}<GlobeHemisphereWestIcon weight="bold" />{/snippet}
          Public page
        </Button>
      {/if}
    </header>

    {#if page.url.searchParams.get("created") === "true" && navigation[0] && isActive(navigation[0].href)}
      <div class="success" role="status">
        Version 1.0.0 is published and ready for retrieval.
      </div>
    {/if}

    <nav aria-label="Skill">
      {#each navigation as item (item.href)}
        <a
          href={item.href}
          class:active={isActive(item.href)}
          aria-current={isActive(item.href) ? "page" : undefined}
        >
          {item.label}
        </a>
      {/each}
    </nav>

    <div class="detail-content">{@render children()}</div>
  </div>
{/if}

<style>
  .detail-page {
    width: min(100%, 78rem);
    margin: 0 auto;
    padding: var(--sp-space-6) var(--sp-space-6) var(--sp-space-16);
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  .skill-heading {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-4);
    align-items: start;
    margin-top: var(--sp-space-5);
  }

  .skill-mark {
    display: grid;
    width: 2.75rem;
    height: 2.75rem;
    place-items: center;
    border: 1px solid var(--sp-color-accent);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-5);
    font-weight: var(--sp-weight-bold);
  }

  .title-row,
  .meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--sp-space-2);
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    font-size: var(--sp-font-size-7);
    letter-spacing: -0.035em;
  }

  .skill-heading p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
  }

  .meta {
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  code {
    font-family: var(--sp-font-mono);
  }

  .success {
    margin-top: var(--sp-space-4);
    border: 1px solid var(--sp-color-success);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-3);
  }

  nav {
    display: flex;
    gap: var(--sp-space-4);
    overflow-x: auto;
    margin-top: var(--sp-space-6);
    border-bottom: 1px solid var(--sp-color-border);
  }

  nav a {
    flex: none;
    border-bottom: 2px solid transparent;
    padding: var(--sp-space-3) 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-medium);
    text-decoration: none;
  }

  nav a:hover,
  nav a.active {
    color: var(--sp-color-text);
  }

  nav a.active {
    border-color: var(--sp-color-accent);
  }

  .detail-content {
    min-width: 0;
    margin-top: var(--sp-space-5);
  }

  @media (max-width: 48rem) {
    .detail-page {
      padding: var(--sp-space-5) var(--sp-space-3) var(--sp-space-12);
    }

    .skill-heading {
      grid-template-columns: auto minmax(0, 1fr);
    }

    .skill-heading > :global(a) {
      grid-column: 1 / -1;
      justify-self: start;
    }
  }
</style>
