<script lang="ts">
  import { resolve } from "$app/paths";
  import {
    ArrowUpRightIcon as ArrowUpRight,
    ClockIcon as Clock,
    StackIcon as Stack,
  } from "phosphor-svelte";
  import type { PublicSkillSummary } from "$lib/public-skills.js";

  let { skill }: { skill: PublicSkillSummary } = $props();

  const updated = $derived(
    new Intl.DateTimeFormat("en", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    }).format(new Date(skill.updatedAt)),
  );
</script>

<article>
  <a
    class="card-link"
    href={resolve("/skills/[workspaceSlug]/[skillSlug]", {
      workspaceSlug: skill.workspaceSlug,
      skillSlug: skill.slug,
    })}
    aria-label={`Open ${skill.name} by ${skill.workspaceSlug}`}
  >
    <div class="card-topline">
      <span class="skill-icon"
        ><Stack size={18} weight="duotone" aria-hidden="true" /></span
      >
      <ArrowUpRight size={17} aria-hidden="true" />
    </div>
    <p class="workspace">{skill.workspaceSlug}</p>
    <h2>{skill.name}</h2>
    <p class="description">{skill.description}</p>
    <div class="tags" aria-label="Tags">
      {#each skill.tags.slice(0, 4) as tag (tag)}
        <span>{tag}</span>
      {/each}
    </div>
    <div class="metadata">
      <span>v{skill.semanticVersion}</span>
      <span><Clock size={13} aria-hidden="true" /> Updated {updated}</span>
    </div>
  </a>
</article>

<style>
  article {
    min-width: 0;
  }

  .card-link {
    display: flex;
    min-height: 19rem;
    height: 100%;
    flex-direction: column;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
    color: var(--sp-color-text);
    text-decoration: none;
    box-shadow: var(--sp-shadow-sm);
    transition:
      transform var(--sp-duration-normal) var(--sp-ease-standard),
      border-color var(--sp-duration-normal) var(--sp-ease-standard),
      box-shadow var(--sp-duration-normal) var(--sp-ease-standard);
  }

  .card-link:hover {
    transform: translateY(-2px);
    border-color: var(--sp-color-border-strong);
    box-shadow: var(--sp-shadow-md);
  }

  .card-topline {
    display: flex;
    align-items: center;
    justify-content: space-between;
    color: var(--sp-color-text-subtle);
  }

  .skill-icon {
    display: grid;
    width: 2.5rem;
    height: 2.5rem;
    place-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .workspace {
    margin: var(--sp-space-6) 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  h2 {
    margin: 0;
    font-size: var(--sp-font-size-6);
    letter-spacing: -0.025em;
  }

  .description {
    display: -webkit-box;
    overflow: hidden;
    margin: var(--sp-space-3) 0 var(--sp-space-5);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: 1.6;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 3;
    line-clamp: 3;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    margin-top: auto;
  }

  .tags span {
    border-radius: var(--sp-radius-round);
    padding: 0.25rem 0.5rem;
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-1);
  }

  .metadata {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
    margin-top: var(--sp-space-5);
    border-top: 1px solid var(--sp-color-border);
    padding-top: var(--sp-space-4);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .metadata span:last-child {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
  }
</style>
