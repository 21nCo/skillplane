<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button, Input, Select } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { listSkills } from "$lib/skills/api.js";
  import type {
    Skill,
    SkillArchiveFilter,
    SkillVisibility,
  } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    ArchiveIcon,
    BookOpenTextIcon,
    MagnifyingGlassIcon,
    PlusIcon,
  } from "phosphor-svelte";

  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(Boolean(workspace && workspace.role !== "viewer"));

  let skills = $state<Skill[]>([]);
  let query = $state("");
  let visibility = $state<SkillVisibility | "all">("all");
  let archive = $state<SkillArchiveFilter>("active");
  let nextCursor = $state<string | null>(null);
  let loading = $state(true);
  let loadingMore = $state(false);
  let error = $state<string | null>(null);
  let loadedWorkspaceId = $state<string | null>(null);

  async function load(reset = true) {
    if (!workspace) return;
    if (reset) {
      loading = true;
      nextCursor = null;
    } else {
      loadingMore = true;
    }
    error = null;
    try {
      const result = await listSkills({
        workspaceId: workspace.id,
        query,
        archive,
        visibility: visibility === "all" ? [] : [visibility],
        cursor: reset ? null : nextCursor,
        limit: 20,
      });
      skills = reset ? [...result.skills] : [...skills, ...result.skills];
      nextCursor = result.nextCursor;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Skills could not be loaded.";
    } finally {
      loading = false;
      loadingMore = false;
    }
  }

  function search(event: SubmitEvent) {
    event.preventDefault();
    void load();
  }

  $effect(() => {
    if (workspace && loadedWorkspaceId !== workspace.id) {
      loadedWorkspaceId = workspace.id;
      void load();
    }
  });

  function visibilityTone(value: SkillVisibility) {
    if (value === "public") return "success" as const;
    if (value === "workspace") return "info" as const;
    return "neutral" as const;
  }
</script>

<svelte:head>
  <title>Skills · {workspace?.name ?? "Skillplane"}</title>
</svelte:head>

<main class="skill-page">
  <header class="page-heading">
    <div>
      <p class="eyebrow">Knowledge plane</p>
      <h1>Skills</h1>
      <p>
        Versioned instructions that humans and agents can retrieve with a complete audit
        trail.
      </p>
    </div>
    {#if workspace && canWrite}
      <Button
        href={resolve("/(app)/[workspaceSlug]/skills/new", {
          workspaceSlug: workspace.slug,
        })}
      >
        {#snippet leading()}<PlusIcon weight="bold" />{/snippet}
        New skill
      </Button>
    {/if}
  </header>

  {#if page.url.searchParams.get("created") === "true"}
    <div class="success" role="status">
      The skill and immutable version 1.0.0 were published successfully.
    </div>
  {/if}

  <section class="filters" aria-label="Skill filters">
    <form onsubmit={search}>
      <Input
        label="Search skills"
        hideLabel
        placeholder="Search names, tags, and published instructions"
        bind:value={query}
      />
      <Button type="submit" variant="secondary">
        {#snippet leading()}<MagnifyingGlassIcon weight="bold" />{/snippet}
        Search
      </Button>
    </form>
    <Select
      label="Visibility"
      options={[
        { value: "all", label: "All visibility" },
        { value: "private", label: "Private" },
        { value: "workspace", label: "Workspace" },
        { value: "public", label: "Public" },
      ]}
      bind:value={visibility}
      onchange={() => void load()}
    />
    <Select
      label="Lifecycle state"
      options={[
        { value: "active", label: "Active" },
        { value: "archived", label: "Archived" },
        { value: "all", label: "Active and archived" },
      ]}
      bind:value={archive}
      onchange={() => void load()}
    />
  </section>

  {#if loading}
    <SkillState
      kind="loading"
      title="Loading skills"
      message="Loading the authorized skill inventory."
    />
  {:else if error}
    <SkillState
      kind="error"
      title="Skills could not be loaded"
      message={error}
      retry={() => void load()}
    />
  {:else if skills.length === 0}
    <SkillState
      kind="empty"
      title={query || visibility !== "all" || archive !== "active"
        ? "No skills match these filters"
        : "Create your first skill"}
      message={query || visibility !== "all" || archive !== "active"
        ? "Change the search or filters and try again."
        : canWrite
          ? "Author Markdown directly or upload a portable Skillplane bundle."
          : "Your viewer role can inspect skills after an editor publishes one."}
    >
      {#if workspace && canWrite}
        <Button
          href={resolve("/(app)/[workspaceSlug]/skills/new", {
            workspaceSlug: workspace.slug,
          })}
        >
          Create skill
        </Button>
      {/if}
    </SkillState>
  {:else}
    <section class="inventory" aria-label="Skill inventory">
      {#each skills as skill (skill.id)}
        <article class:archived={Boolean(skill.archivedAt)}>
          <a
            class="skill-link"
            href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]", {
              workspaceSlug: workspace?.slug ?? page.params.workspaceSlug ?? "",
              skillSlug: skill.slug,
            })}
          >
            <span class="skill-icon" aria-hidden="true">
              {#if skill.archivedAt}
                <ArchiveIcon weight="duotone" />
              {:else}
                <BookOpenTextIcon weight="duotone" />
              {/if}
            </span>
            <span class="copy">
              <span class="title-row">
                <strong>{skill.name}</strong>
                <Badge tone={visibilityTone(skill.visibility)}>
                  {skill.visibility}
                </Badge>
                {#if skill.archivedAt}<Badge tone="warning">Archived</Badge>{/if}
              </span>
              <span class="description">
                {skill.description || "No description provided."}
              </span>
              <span class="meta">
                <code>{skill.slug}</code>
                <span>v{skill.currentSemanticVersion ?? "unpublished"}</span>
                <time datetime={skill.updatedAt}>
                  Updated
                  {new Intl.RelativeTimeFormat(undefined, {
                    numeric: "auto",
                  }).format(
                    Math.round(
                      (new Date(skill.updatedAt).getTime() - Date.now()) / 86_400_000,
                    ),
                    "day",
                  )}
                </time>
              </span>
            </span>
          </a>
        </article>
      {/each}
    </section>

    {#if nextCursor}
      <div class="pagination">
        <Button
          variant="secondary"
          loading={loadingMore}
          onclick={() => void load(false)}
        >
          Load more skills
        </Button>
      </div>
    {/if}
  {/if}
</main>

<style>
  .skill-page {
    width: min(100%, 78rem);
    margin: 0 auto;
    padding: var(--sp-space-8) var(--sp-space-6) var(--sp-space-16);
  }

  .page-heading {
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--sp-space-6);
  }

  .eyebrow {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1,
  p {
    margin: 0;
  }

  h1 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-7);
    letter-spacing: -0.035em;
  }

  .page-heading p:last-child {
    max-width: 46rem;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
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

  .filters {
    display: grid;
    grid-template-columns: minmax(18rem, 1fr) 11rem 12rem;
    gap: var(--sp-space-3);
    align-items: end;
    margin: var(--sp-space-6) 0 var(--sp-space-4);
  }

  form {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-space-2);
  }

  .inventory {
    display: grid;
    gap: var(--sp-space-2);
  }

  article {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  article:hover {
    border-color: var(--sp-color-border-strong);
    background: var(--sp-color-surface-hover);
  }

  article.archived {
    opacity: 0.78;
  }

  .skill-link {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-3);
    padding: var(--sp-space-4);
    color: inherit;
    text-decoration: none;
  }

  .skill-icon {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .copy,
  .title-row,
  .description,
  .meta {
    min-width: 0;
  }

  .title-row,
  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
  }

  .description {
    display: block;
    overflow: hidden;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta {
    margin-top: var(--sp-space-3);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  code {
    font-family: var(--sp-font-mono);
  }

  .pagination {
    display: flex;
    justify-content: center;
    padding: var(--sp-space-5);
  }

  @media (max-width: 52rem) {
    .skill-page {
      padding: var(--sp-space-5) var(--sp-space-3) var(--sp-space-12);
    }

    .page-heading {
      align-items: flex-start;
    }

    .filters {
      grid-template-columns: 1fr 1fr;
    }

    .filters form {
      grid-column: 1 / -1;
    }
  }

  @media (max-width: 34rem) {
    .page-heading {
      display: grid;
    }

    .filters {
      grid-template-columns: 1fr;
    }

    .filters form {
      grid-column: auto;
    }

    .description {
      white-space: normal;
    }
  }
</style>
