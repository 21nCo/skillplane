<script lang="ts">
  import { resolve } from "$app/paths";
  import { Badge } from "@skillplane/ui";
  import { GitBranchIcon, RobotIcon, UserCircleIcon } from "phosphor-svelte";
  import type { SkillVersion } from "./types.js";

  let {
    versions,
    workspaceSlug,
    skillSlug,
  }: {
    versions: readonly SkillVersion[];
    workspaceSlug: string;
    skillSlug: string;
  } = $props();

  function tone(status: SkillVersion["status"]) {
    if (status === "published") return "success" as const;
    if (status === "pending_review") return "warning" as const;
    if (status === "rejected") return "danger" as const;
    return "neutral" as const;
  }
</script>

<ol class="timeline" aria-label="Version history">
  {#each versions as version (version.id)}
    <li>
      <span class="rail" aria-hidden="true">
        <span></span>
      </span>
      <a
        href={resolve(
          "/(app)/[workspaceSlug]/skills/[skillSlug]/versions/[versionId]",
          {
            workspaceSlug,
            skillSlug,
            versionId: version.id,
          },
        )}
      >
        <div class="version-title">
          <span>
            {#if version.source === "agent_amendment"}
              <RobotIcon weight="duotone" aria-hidden="true" />
            {:else if version.source === "human"}
              <UserCircleIcon weight="duotone" aria-hidden="true" />
            {:else}
              <GitBranchIcon weight="duotone" aria-hidden="true" />
            {/if}
            <strong>
              {version.semanticVersion
                ? `v${version.semanticVersion}`
                : `Revision ${String(version.revision)}`}
            </strong>
          </span>
          <Badge tone={tone(version.status)}>
            {version.status.replace("_", " ")}
          </Badge>
        </div>
        <p>{version.changeSummary}</p>
        <small>
          Revision {version.revision} · {version.source.replace("_", " ")} ·
          <time datetime={version.createdAt}>
            {new Intl.DateTimeFormat(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }).format(new Date(version.createdAt))}
          </time>
        </small>
      </a>
    </li>
  {/each}
</ol>

<style>
  .timeline {
    display: grid;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr);
    gap: var(--sp-space-3);
  }

  .rail {
    position: relative;
    display: flex;
    justify-content: center;
  }

  .rail::after {
    position: absolute;
    top: 1.1rem;
    bottom: 0;
    width: 1px;
    background: var(--sp-color-border);
    content: "";
  }

  li:last-child .rail::after {
    display: none;
  }

  .rail span {
    position: relative;
    z-index: 1;
    width: 0.625rem;
    height: 0.625rem;
    margin-top: 1rem;
    border: 2px solid var(--sp-color-accent);
    border-radius: 50%;
    background: var(--sp-color-canvas);
  }

  a {
    display: block;
    margin-bottom: var(--sp-space-3);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface);
    color: inherit;
    text-decoration: none;
  }

  a:hover {
    border-color: var(--sp-color-border-strong);
    background: var(--sp-color-surface-hover);
  }

  .version-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-3);
  }

  .version-title > span {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
  }

  p {
    margin: var(--sp-space-2) 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  small {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    text-transform: capitalize;
  }
</style>
