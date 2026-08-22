<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge } from "@skillplane/ui";
  import LearningMetadata from "$lib/skills/LearningMetadata.svelte";
  import ReviewDecision from "$lib/skills/ReviewDecision.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import VersionDiff from "$lib/skills/VersionDiff.svelte";
  import {
    decideAmendmentReview,
    getAmendmentReview,
    getSkillDiff,
  } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type { AmendmentReviewDetail, SkillVersionDiff } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    ArrowLeftIcon,
    FingerprintIcon,
    GitDiffIcon,
    RobotIcon,
    ShieldCheckIcon,
  } from "phosphor-svelte";

  const skill = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canDecide = $derived(
    Boolean(workspace && (workspace.role === "admin" || workspace.role === "owner")),
  );
  let detail = $state<AmendmentReviewDetail | null>(null);
  let diff = $state<SkillVersionDiff | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let loadedKey = $state("");

  async function load() {
    if (!workspace || !skill.skill || !page.params.reviewId) return;
    loading = true;
    error = null;
    try {
      const review = await getAmendmentReview({
        workspaceId: workspace.id,
        skillId: skill.skill.id,
        reviewId: page.params.reviewId,
      });
      detail = review;
      diff = review.candidate.baseVersionId
        ? await getSkillDiff({
            workspaceId: workspace.id,
            skillId: skill.skill.id,
            fromVersionId: review.candidate.baseVersionId,
            toVersionId: review.candidate.id,
          })
        : null;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Candidate review could not load.";
    } finally {
      loading = false;
    }
  }

  async function decide(
    decision: "approve" | "reject",
    reason: string,
  ): Promise<boolean> {
    if (!workspace || !skill.skill || !detail) return false;
    busy = true;
    actionError = null;
    try {
      detail = await decideAmendmentReview({
        workspaceId: workspace.id,
        skillId: skill.skill.id,
        reviewId: detail.review.id,
        decision,
        reason,
        idempotencyKey: crypto.randomUUID(),
      });
      const reportRefreshFailure = (cause: unknown) => {
        actionError =
          cause instanceof Error
            ? `Review decision was saved, but the skill could not refresh: ${cause.message}`
            : "Review decision was saved, but the skill could not refresh.";
      };
      try {
        skill.replaceVersion(detail.candidate);
        void skill.refresh().catch(reportRefreshFailure);
      } catch (cause) {
        reportRefreshFailure(cause);
      }
      return true;
    } catch (cause) {
      actionError =
        cause instanceof Error ? cause.message : "Review decision was not saved.";
      return false;
    } finally {
      busy = false;
    }
  }

  $effect(() => {
    const key =
      workspace && skill.skill && page.params.reviewId
        ? `${workspace.id}:${skill.skill.id}:${page.params.reviewId}`
        : "";
    if (key && key !== loadedKey) {
      loadedKey = key;
      void load();
    }
  });
</script>

<svelte:head>
  <title>Candidate review · {skill.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if workspace && skill.skill}
  <a
    class="back"
    href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/candidates", {
      workspaceSlug: workspace.slug,
      skillSlug: skill.skill.slug,
    })}
  >
    <ArrowLeftIcon weight="bold" /> Candidate reviews
  </a>

  {#if loading}
    <SkillState
      kind="loading"
      title="Loading review"
      message="Verifying candidate provenance and calculating its exact diff."
    />
  {:else if error !== null || detail === null}
    <SkillState
      kind="error"
      title="Review could not be loaded"
      message={error ?? "The review is unavailable."}
      retry={() => void load()}
    />
  {:else}
    <div class="review-page">
      <header class="review-heading">
        <div>
          <p>Candidate revision {detail.candidate.revision}</p>
          <h2>{detail.candidate.changeSummary}</h2>
          <span>
            Proposed {detail.candidate.proposedBump ?? "patch"} bump ·
            {detail.candidate.digest}
          </span>
        </div>
        <div class="badges">
          <Badge
            tone={detail.review.status === "approved"
              ? "success"
              : detail.review.status === "rejected"
                ? "danger"
                : "warning"}
          >
            {detail.review.status}
          </Badge>
          <Badge
            tone={detail.review.policyDecision.outcome === "auto_publish"
              ? "success"
              : "info"}
          >
            {detail.review.policyDecision.outcome.replaceAll("_", " ")}
          </Badge>
        </div>
      </header>

      <section class="panel identities">
        <header>
          <FingerprintIcon weight="duotone" />
          <div>
            <p>Identity boundary</p>
            <h3>Authenticated actor and declared caller</h3>
          </div>
        </header>
        <div class="identity-grid">
          <article>
            <ShieldCheckIcon weight="fill" />
            <div>
              <span>Authenticated requester</span>
              <strong>
                {detail.review.requestedByActorType.replace("_", " ")}
              </strong>
              <code>{detail.review.requestedByActorId}</code>
              <small>Server-derived credential or session identity</small>
            </div>
          </article>
          <article>
            <RobotIcon weight="duotone" />
            <div>
              <span>Declared agent caller</span>
              <strong>
                {detail.review.requestedByAgent ?? "Unknown agent"} ·
                {detail.review.requestedByModel ?? "Unknown model"}
              </strong>
              {#if "client" in detail.candidate.callerDeclaration}
                <code>
                  {detail.candidate.callerDeclaration.client} /
                  {detail.candidate.callerDeclaration.runId}
                </code>
              {/if}
              <small>
                Declared for user
                <code>{detail.review.requestedForUserId ?? "not declared"}</code>
              </small>
            </div>
          </article>
        </div>
      </section>

      <section class="panel decision-panel">
        <ReviewDecision review={detail.review} {canDecide} {busy} ondecide={decide} />
        {#if actionError}
          <SkillState
            kind={actionError.toLocaleLowerCase().includes("conflict")
              ? "conflict"
              : "error"}
            title="Review state was not changed"
            message={actionError}
          />
        {/if}
      </section>

      <section class="panel">
        <LearningMetadata metadata={detail.candidate.learningMetadata} />
      </section>

      <section class="panel operations">
        <header>
          <GitDiffIcon weight="duotone" />
          <div>
            <p>Deterministic file operations</p>
            <h3>{detail.candidate.amendmentOperations.length} requested changes</h3>
          </div>
        </header>
        <ul>
          {#each detail.candidate.amendmentOperations as operation (operation.path)}
            <li>
              <Badge
                tone={operation.operation === "add"
                  ? "success"
                  : operation.operation === "delete"
                    ? "danger"
                    : "info"}
              >
                {operation.operation}
              </Badge>
              <code>{operation.path}</code>
              <span>
                {operation.expectedSha256
                  ? `expected ${operation.expectedSha256.slice(0, 16)}…`
                  : "expected path to be absent"}
              </span>
            </li>
          {/each}
        </ul>
      </section>

      <section class="panel">
        <header class="section-heading">
          <div>
            <p>Exact bundle diff</p>
            <h3>Base → candidate</h3>
          </div>
        </header>
        {#if diff}
          <VersionDiff files={diff.files} />
        {:else}
          <p class="muted">This candidate has no base version to compare.</p>
        {/if}
      </section>
    </div>
  {/if}
{/if}

<style>
  .back {
    display: inline-flex;
    gap: var(--sp-space-1);
    align-items: center;
    margin-bottom: var(--sp-space-4);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    text-decoration: none;
  }

  .review-page {
    display: grid;
    gap: var(--sp-space-4);
  }

  .review-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
  }

  .review-heading p,
  .review-heading h2,
  .review-heading span,
  .panel p,
  .panel h3 {
    margin: 0;
  }

  .review-heading p,
  .panel > header p,
  .section-heading p {
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .review-heading h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-6);
  }

  .review-heading span {
    display: block;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
    overflow-wrap: anywhere;
  }

  .badges {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-2);
  }

  .panel {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface-raised);
  }

  .panel > header:not(.section-heading) {
    display: flex;
    gap: var(--sp-space-3);
    align-items: center;
    margin-bottom: var(--sp-space-3);
    padding-bottom: var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .panel > header > :global(svg) {
    width: 1.5rem;
    height: 1.5rem;
    color: var(--sp-color-accent-text);
  }

  .panel h3 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-4);
  }

  .identity-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3);
  }

  .identity-grid article {
    display: flex;
    gap: var(--sp-space-3);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-surface);
  }

  .identity-grid article > :global(svg) {
    width: 1.4rem;
    height: 1.4rem;
    flex: none;
    color: var(--sp-color-accent-text);
  }

  .identity-grid span,
  .identity-grid strong,
  .identity-grid code,
  .identity-grid small {
    display: block;
  }

  .identity-grid span,
  .identity-grid small {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .identity-grid strong {
    margin: var(--sp-space-1) 0;
  }

  code {
    overflow-wrap: anywhere;
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .operations ul {
    display: grid;
    gap: var(--sp-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .operations li {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--sp-space-3);
    align-items: center;
    border-top: 1px solid var(--sp-color-border);
    padding-top: var(--sp-space-2);
  }

  .operations li:first-child {
    border-top: 0;
    padding-top: 0;
  }

  .operations li span,
  .muted {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  .section-heading {
    margin-bottom: var(--sp-space-3);
  }

  .decision-panel {
    box-shadow: var(--sp-shadow-lg);
  }

  @media (max-width: 46rem) {
    .review-heading {
      flex-direction: column;
    }

    .identity-grid {
      grid-template-columns: 1fr;
    }

    .operations li {
      grid-template-columns: auto 1fr;
    }

    .operations li span {
      grid-column: 2;
    }
  }
</style>
