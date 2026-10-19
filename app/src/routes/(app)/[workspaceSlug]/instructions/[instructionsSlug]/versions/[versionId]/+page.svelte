<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button, Textarea } from "@skillplane/ui";
  import ReviewDecision from "$lib/skills/ReviewDecision.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import VersionDiff from "$lib/skills/VersionDiff.svelte";
  import {
    decideAmendmentReview,
    getSkillDiff,
    getSkillVersion,
    listAmendmentReviews,
    publishCandidate,
    rejectCandidate,
  } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type {
    AmendmentReview,
    SkillVersion,
    SkillVersionDiff,
  } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowLeftIcon, CheckCircleIcon, GitDiffIcon } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canPublish = $derived(
    Boolean(workspace && (workspace.role === "admin" || workspace.role === "owner")),
  );
  let version = $state<SkillVersion | null>(null);
  // Agent amendments are decided through their review; human candidates directly.
  let review = $state<AmendmentReview | null>(null);
  let diff = $state<SkillVersionDiff | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let refreshError = $state<string | null>(null);
  let reason = $state("");
  let loadedKey = $state("");

  async function load() {
    const versionId = page.params.versionId;
    if (!workspace || !detail.skill || !versionId) return;
    loading = true;
    error = null;
    try {
      const selected = await getSkillVersion(workspace.id, detail.skill.id, versionId);
      const [comparison, reviews] = await Promise.all([
        selected.baseVersionId
          ? getSkillDiff({
              workspaceId: workspace.id,
              skillId: detail.skill.id,
              fromVersionId: selected.baseVersionId,
              toVersionId: selected.id,
            })
          : null,
        selected.source === "agent_amendment"
          ? listAmendmentReviews({
              workspaceId: workspace.id,
              skillId: detail.skill.id,
            })
          : [],
      ]);
      version = selected;
      diff = comparison;
      review =
        reviews.find((entry) => entry.review.proposedVersionId === selected.id)
          ?.review ?? null;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The version could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function settle(operation: () => Promise<SkillVersion>): Promise<boolean> {
    busy = true;
    actionError = null;
    refreshError = null;
    try {
      version = await operation();
    } catch (cause) {
      actionError =
        cause instanceof Error ? cause.message : "The candidate state was not changed.";
      busy = false;
      return false;
    }
    // The decision is saved; a failed refresh must not report it as unchanged.
    try {
      detail.replaceVersion(version);
      await detail.refresh();
    } catch (cause) {
      refreshError =
        cause instanceof Error ? cause.message : "The instructions could not refresh.";
    }
    busy = false;
    return true;
  }

  function decideHuman(decision: "approve" | "reject") {
    if (!workspace || !detail.skill || !version) return;
    const options = {
      workspaceId: workspace.id,
      skillId: detail.skill.id,
      versionId: version.id,
      idempotencyKey: crypto.randomUUID(),
    };
    void settle(() =>
      decision === "approve"
        ? publishCandidate(options)
        : rejectCandidate({ ...options, reason: reason.trim() }),
    );
  }

  async function decideAmendment(
    decision: "approve" | "reject",
    rationale: string,
  ): Promise<boolean> {
    if (!workspace || !detail.skill || !review) return false;
    const reviewId = review.id;
    const skillId = detail.skill.id;
    return settle(async () => {
      const decided = await decideAmendmentReview({
        workspaceId: workspace.id,
        skillId,
        reviewId,
        decision,
        reason: rationale,
        idempotencyKey: crypto.randomUUID(),
      });
      review = decided.review;
      return decided.candidate;
    });
  }

  $effect(() => {
    const key =
      workspace && detail.skill && page.params.versionId
        ? `${workspace.id}:${detail.skill.id}:${page.params.versionId}`
        : "";
    if (key && key !== loadedKey) {
      loadedKey = key;
      void load();
    }
  });
</script>

<svelte:head>
  <title>
    {version?.semanticVersion
      ? `v${version.semanticVersion}`
      : `Revision ${String(version?.revision ?? "")}`} · {detail.skill?.name ??
      "Skillplane"}
  </title>
</svelte:head>

{#if workspace && detail.skill}
  <a
    class="back"
    href={resolve("/(app)/[workspaceSlug]/instructions/[instructionsSlug]/versions", {
      workspaceSlug: workspace.slug,
      instructionsSlug: detail.skill.slug,
    })}
  >
    <ArrowLeftIcon weight="bold" aria-hidden="true" /> Version history
  </a>

  {#if loading}
    <SkillState
      kind="loading"
      title="Loading version"
      message="Reading immutable metadata and calculating the diff."
    />
  {:else if error !== null || !version}
    <SkillState
      kind="error"
      title="Version could not be loaded"
      message={error ?? "The requested version is not available."}
      retry={() => void load()}
    />
  {:else}
    <header class="version-heading">
      <div>
        <p>
          Immutable revision {version.revision} · {version.source.replace("_", " ")}
        </p>
        <h2>
          {version.semanticVersion
            ? `Version ${version.semanticVersion}`
            : `Candidate revision ${String(version.revision)}`}
        </h2>
        <span>{version.changeSummary}</span>
      </div>
      <Badge
        tone={version.status === "published"
          ? "success"
          : version.status === "pending_review"
            ? "warning"
            : version.status === "rejected"
              ? "danger"
              : "neutral"}
      >
        {version.status.replace("_", " ")}
      </Badge>
    </header>

    {#if page.url.searchParams.get("candidate") === "true"}
      <div class="notice" role="status">
        <CheckCircleIcon weight="fill" aria-hidden="true" />
        Candidate revision {version.revision} was created. Published content remains unchanged
        until approval.
      </div>
    {/if}

    {#if review}
      <section class="panel">
        <ReviewDecision
          {review}
          canDecide={canPublish}
          {busy}
          ondecide={decideAmendment}
        />
      </section>
    {:else if version.status === "pending_review"}
      <section class="panel review">
        <h3>Publication control</h3>
        {#if canPublish}
          <Textarea
            label="Rejection reason"
            description="Required to reject. Publishing assigns the semantic version."
            rows={2}
            maxlength={2000}
            bind:value={reason}
          />
          <div class="actions">
            <Button
              variant="danger"
              disabled={busy || !reason.trim()}
              onclick={() => decideHuman("reject")}
            >
              Reject
            </Button>
            <Button loading={busy} onclick={() => decideHuman("approve")}>
              Publish {version.proposedBump ?? "patch"}
            </Button>
          </div>
        {:else}
          <Badge tone="warning">Admin or owner approval required</Badge>
        {/if}
      </section>
    {/if}

    {#if actionError}
      <SkillState
        kind="error"
        title="Candidate state was not changed"
        message={actionError}
      />
    {/if}
    {#if refreshError}
      <SkillState
        kind="error"
        title="The decision was saved, but the instructions could not refresh"
        message={refreshError}
      />
    {/if}

    <section class="panel">
      <h3>
        {#if diff}
          <GitDiffIcon weight="duotone" aria-hidden="true" />
          Diff from base revision
        {:else}
          Initial version
        {/if}
      </h3>
      {#if diff}
        <VersionDiff files={diff.files} />
      {:else}
        <SkillState
          kind="empty"
          title="Initial published document"
          message="Revision 1 has no earlier base version to compare."
        />
      {/if}
    </section>
  {/if}
{/if}

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  .version-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
    margin: var(--sp-space-4) 0;
  }

  .version-heading p,
  h2,
  h3 {
    margin: 0;
  }

  .version-heading p {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
    text-transform: capitalize;
  }

  h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-6);
  }

  .version-heading span {
    display: block;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
  }

  h3 {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin-bottom: var(--sp-space-3);
    font-size: var(--sp-font-size-4);
  }

  .notice {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin-bottom: var(--sp-space-4);
    border: 1px solid var(--sp-color-success);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-3);
  }

  .panel {
    margin-bottom: var(--sp-space-4);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface);
  }

  .review {
    display: grid;
    gap: var(--sp-space-3);
  }

  .review h3 {
    margin: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--sp-space-2);
  }
</style>
