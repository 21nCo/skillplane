<script lang="ts">
  import { untrack } from "svelte";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button, Textarea } from "@skillplane/ui";
  import { CandidateReviewController } from "$lib/instructions/candidate-review.svelte.js";
  import ReviewDecision from "$lib/skills/ReviewDecision.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import VersionDiff from "$lib/skills/VersionDiff.svelte";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
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
  const candidate = new CandidateReviewController(async (decided) => {
    detail.replaceVersion(decided);
    await detail.refresh();
  });
  const version = $derived(candidate.version);
  const control = $derived(candidate.control);
  const decideAmendment = (decision: "approve" | "reject", rationale: string) =>
    candidate.decideAmendment(decision, rationale);
  let reason = $state("");
  let loadedKey = "";

  $effect(() => {
    const workspaceId = workspace?.id;
    const skillId = detail.skill?.id;
    const versionId = page.params.versionId;
    if (!workspaceId || !skillId || !versionId) return;
    const key = `${workspaceId}:${skillId}:${versionId}`;
    if (key === loadedKey) return;
    loadedKey = key;
    reason = "";
    untrack(() => void candidate.load({ workspaceId, skillId, versionId }));
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

  {#if candidate.loading}
    <SkillState
      kind="loading"
      title="Loading version"
      message="Reading immutable metadata and calculating the diff."
    />
  {:else if candidate.error !== null || !version}
    <SkillState
      kind="error"
      title="Version could not be loaded"
      message={candidate.error ?? "The requested version is not available."}
      retry={() => candidate.retry()}
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

    {#if control.kind === "agent"}
      <section class="panel">
        <ReviewDecision
          review={control.review}
          canDecide={canPublish}
          busy={candidate.busy}
          ondecide={decideAmendment}
        />
      </section>
    {:else if control.kind === "agent_review_missing"}
      <SkillState
        kind="error"
        title="Agent review could not be found"
        message="This agent amendment is decided through its review. Publication controls stay hidden until the review loads."
        retry={() => candidate.retry()}
      />
    {:else if control.kind === "human"}
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
              disabled={candidate.busy || !reason.trim()}
              onclick={() => void candidate.reject(reason.trim())}
            >
              Reject
            </Button>
            <Button loading={candidate.busy} onclick={() => void candidate.publish()}>
              Publish {version.proposedBump ?? "patch"}
            </Button>
          </div>
        {:else}
          <Badge tone="warning">Admin or owner approval required</Badge>
        {/if}
      </section>
    {/if}

    {#if candidate.actionError}
      <SkillState
        kind="error"
        title="Candidate state was not changed"
        message={candidate.actionError}
      />
    {/if}
    {#if candidate.refreshError}
      <SkillState
        kind="error"
        title="The decision was saved, but the instructions could not refresh"
        message={candidate.refreshError}
      />
    {/if}

    <section class="panel">
      <h3>
        {#if candidate.diff}
          <GitDiffIcon weight="duotone" aria-hidden="true" />
          Diff from base revision
        {:else}
          Initial version
        {/if}
      </h3>
      {#if candidate.diff}
        <VersionDiff files={candidate.diff.files} />
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
