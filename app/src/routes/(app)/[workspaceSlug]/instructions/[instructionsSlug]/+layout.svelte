<script lang="ts">
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { Badge } from "@skillplane/ui";
  import KindBadge from "$lib/skills/KindBadge.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { provideSkillDetailStore } from "$lib/skills/store.svelte.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowLeftIcon } from "phosphor-svelte";
  import type { Snippet } from "svelte";

  let { children }: { children: Snippet } = $props();
  const workspaces = useWorkspaceStore();
  const detail = provideSkillDetailStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const slug = $derived(page.params.instructionsSlug ?? "");
  // A skill opened here belongs on its skill pages, which read SKILL.md.
  const isSkill = $derived(detail.skill?.kind === "skill");
  const navigation = $derived(
    workspace
      ? [
          {
            label: "Document",
            href: resolve("/(app)/[workspaceSlug]/instructions/[instructionsSlug]", {
              workspaceSlug: workspace.slug,
              instructionsSlug: slug,
            }),
          },
          ...(workspace.role === "viewer"
            ? []
            : [
                {
                  label: "Edit",
                  href: resolve(
                    "/(app)/[workspaceSlug]/instructions/[instructionsSlug]/edit",
                    { workspaceSlug: workspace.slug, instructionsSlug: slug },
                  ),
                },
              ]),
          {
            label: "Versions",
            href: resolve(
              "/(app)/[workspaceSlug]/instructions/[instructionsSlug]/versions",
              { workspaceSlug: workspace.slug, instructionsSlug: slug },
            ),
          },
        ]
      : [],
  );

  $effect(() => {
    if (workspace && slug) void detail.load(workspace.id, slug);
  });

  $effect(() => {
    if (workspace && detail.skill && isSkill && detail.skill.slug === slug) {
      void goto(
        resolve("/(app)/[workspaceSlug]/skills/[skillSlug]", {
          workspaceSlug: workspace.slug,
          skillSlug: detail.skill.slug,
        }),
        { replaceState: true },
      );
    }
  });

  function isActive(href: string): boolean {
    if (href.endsWith(`/${slug}`)) return page.url.pathname === href;
    return page.url.pathname === href || page.url.pathname.startsWith(`${href}/`);
  }
</script>

{#if detail.loading || isSkill}
  <main class="detail-page">
    <SkillState
      kind="loading"
      title="Loading instructions"
      message="Loading immutable versions and metadata."
    />
  </main>
{:else if detail.error !== null || !detail.skill || !workspace}
  <main class="detail-page">
    <SkillState
      kind="error"
      title="Instructions could not be loaded"
      message={detail.error ?? "The instructions do not exist or access was removed."}
      retry={() => workspace && slug && void detail.load(workspace.id, slug, true)}
    />
  </main>
{:else}
  <div class="detail-page">
    <a
      class="back"
      href={resolve("/(app)/[workspaceSlug]/instructions", {
        workspaceSlug: workspace.slug,
      })}
    >
      <ArrowLeftIcon weight="bold" aria-hidden="true" /> Instructions
    </a>

    <header>
      <div class="title-row">
        <h1>{detail.skill.name}</h1>
        <KindBadge kind={detail.skill.kind} />
        <Badge tone={detail.skill.archivedAt ? "warning" : "success"}>
          {detail.skill.archivedAt ? "Archived" : "Active"}
        </Badge>
        <Badge tone="neutral">{detail.skill.visibility}</Badge>
      </div>
      <p>{detail.skill.description || "No description provided."}</p>
      <div class="meta">
        <code>{detail.skill.slug}</code>
        <span
          >{detail.skill.currentSemanticVersion
            ? `v${detail.skill.currentSemanticVersion}`
            : "unpublished"}</span
        >
        <span>{detail.versions.length} immutable versions</span>
      </div>
    </header>

    {#if page.url.searchParams.get("created") === "true" && navigation[0] && isActive(navigation[0].href)}
      <div class="success" role="status">
        Version 1.0.0 is published and ready for retrieval.
      </div>
    {/if}

    <nav aria-label="Instructions">
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

  header {
    margin-top: var(--sp-space-5);
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

  header p {
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
  }
</style>
