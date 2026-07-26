<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Select } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { listAmendmentReviews } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type {
    AmendmentReviewDetail,
    AmendmentReviewStatus,
  } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    ArrowRightIcon,
    CheckCircleIcon,
    ClockIcon,
    RobotIcon,
    XCircleIcon,
  } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  let reviews = $state<readonly AmendmentReviewDetail[]>([]);
  let status = $state<AmendmentReviewStatus | "all">("all");
  let loading = $state(true);
  let error = $state<string | null>(null);
  let loadedKey = $state("");

  async function load() {
    if (!workspace || !detail.skill) return;
    loading = true;
    error = null;
    try {
      reviews = await listAmendmentReviews({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        status,
      });
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Candidates could not be loaded.";
    } finally {
      loading = false;
    }
  }

  function tone(reviewStatus: AmendmentReviewStatus) {
    return reviewStatus === "approved"
      ? ("success" as const)
      : reviewStatus === "rejected"
        ? ("danger" as const)
        : reviewStatus === "pending"
          ? ("warning" as const)
          : ("neutral" as const);
  }

  $effect(() => {
    const key =
      workspace && detail.skill ? `${workspace.id}:${detail.skill.id}:${status}` : "";
    if (key && key !== loadedKey) {
      loadedKey = key;
      void load();
    }
  });
</script>

<svelte:head>
  <title>Candidates · {detail.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if workspace && detail.skill}
  <div class="candidate-page">
    <header class="page-heading">
      <div>
        <p>Amendment review</p>
        <h2>Candidate revisions</h2>
        <span>
          Every agent improvement remains inspectable, including auto-published
          decisions.
        </span>
      </div>
      <div class="filter">
        <Select
          label="Review state"
          options={[
            { value: "all", label: "All candidates" },
            { value: "pending", label: "Pending review" },
            { value: "approved", label: "Approved" },
            { value: "rejected", label: "Rejected" },
            { value: "superseded", label: "Superseded" },
          ]}
          bind:value={status}
        />
      </div>
    </header>

    <div class="summary" aria-label="Candidate summary">
      <div>
        <ClockIcon weight="duotone" />
        <strong
          >{reviews.filter((item) => item.review.status === "pending").length}</strong
        >
        <span>Pending</span>
      </div>
      <div>
        <CheckCircleIcon weight="duotone" />
        <strong
          >{reviews.filter((item) => item.review.status === "approved").length}</strong
        >
        <span>Approved</span>
      </div>
      <div>
        <XCircleIcon weight="duotone" />
        <strong
          >{reviews.filter((item) => item.review.status === "rejected").length}</strong
        >
        <span>Rejected</span>
      </div>
    </div>

    {#if loading}
      <SkillState
        kind="loading"
        title="Loading candidates"
        message="Reading immutable review and provenance records."
      />
    {:else if error}
      <SkillState
        kind="error"
        title="Candidates could not be loaded"
        message={error}
        retry={() => void load()}
      />
    {:else if reviews.length === 0}
      <SkillState
        kind="empty"
        title={status === "all" ? "No agent amendments yet" : `No ${status} reviews`}
        message="Amendments submitted through MCP will appear here with their exact diff and learning provenance."
      />
    {:else}
      <div class="review-list">
        {#each reviews as item (item.review.id)}
          <a
            href={resolve(
              "/(app)/[workspaceSlug]/skills/[skillSlug]/candidates/[reviewId]",
              {
                workspaceSlug: workspace.slug,
                skillSlug: detail.skill.slug,
                reviewId: item.review.id,
              },
            )}
          >
            <div class="agent-mark" aria-hidden="true">
              <RobotIcon weight="duotone" />
            </div>
            <div class="review-copy">
              <div class="row">
                <strong>{item.candidate.changeSummary}</strong>
                <Badge tone={tone(item.review.status)}>{item.review.status}</Badge>
                {#if item.review.policyDecision.outcome === "auto_publish"}
                  <Badge tone="info">Auto-published</Badge>
                {/if}
              </div>
              <p>
                Revision {item.candidate.revision} ·
                {item.candidate.proposedBump ?? "patch"} proposal ·
                {item.review.requestedByAgent ?? "unknown agent"} /
                {item.review.requestedByModel ?? "unknown model"}
              </p>
              <div class="identity">
                <span>
                  Authenticated {item.review.requestedByActorType.replace("_", " ")}
                  <code>{item.review.requestedByActorId}</code>
                </span>
                <span>
                  Declared for user
                  <code>{item.review.requestedForUserId ?? "not declared"}</code>
                </span>
                <time datetime={item.review.createdAt}>
                  {new Intl.DateTimeFormat(undefined, {
                    dateStyle: "medium",
                    timeStyle: "short",
                  }).format(new Date(item.review.createdAt))}
                </time>
              </div>
            </div>
            <ArrowRightIcon weight="bold" aria-hidden="true" />
          </a>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<style>
  .candidate-page {
    display: grid;
    gap: var(--sp-space-4);
  }

  .page-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: var(--sp-space-4);
  }

  .page-heading p,
  h2,
  .page-heading span {
    margin: 0;
  }

  .page-heading p {
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-5);
  }

  .page-heading span {
    display: block;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .filter {
    width: min(100%, 14rem);
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
  }

  .summary > div {
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: var(--sp-space-2);
    align-items: center;
    padding: var(--sp-space-3);
    border-left: 1px solid var(--sp-color-border);
  }

  .summary > div:first-child {
    border-left: 0;
  }

  .summary :global(svg) {
    width: 1.25rem;
    height: 1.25rem;
    color: var(--sp-color-accent-text);
  }

  .summary span {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .review-list {
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
  }

  .review-list > a {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: center;
    border-top: 1px solid var(--sp-color-border);
    padding: var(--sp-space-3) var(--sp-space-4);
    color: inherit;
    text-decoration: none;
  }

  .review-list > a:first-child {
    border-top: 0;
  }

  .review-list > a:hover {
    background: var(--sp-color-surface-hover);
  }

  .agent-mark {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .row,
  .identity {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
    align-items: center;
  }

  .review-copy p {
    margin: var(--sp-space-1) 0 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  .identity {
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  code {
    font-family: var(--sp-font-mono);
  }

  @media (max-width: 46rem) {
    .page-heading {
      align-items: stretch;
      flex-direction: column;
    }

    .filter {
      width: 100%;
    }

    .summary {
      grid-template-columns: 1fr;
    }

    .summary > div {
      border-top: 1px solid var(--sp-color-border);
      border-left: 0;
    }

    .summary > div:first-child {
      border-top: 0;
    }
  }
</style>
