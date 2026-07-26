<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Badge, Button, Dialog, Input } from "@skillplane/ui";
  import SkillState from "$lib/skills/SkillState.svelte";
  import LearningMetadata from "$lib/skills/LearningMetadata.svelte";
  import VersionDiff from "$lib/skills/VersionDiff.svelte";
  import {
    getSkillDiff,
    getSkillVersion,
    publishCandidate,
    rejectCandidate,
  } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type { SkillVersion, SkillVersionDiff } from "$lib/skills/types.js";
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
  let diff = $state<SkillVersionDiff | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let actionState = $state<"idle" | "publishing" | "rejecting">("idle");
  let actionError = $state<string | null>(null);
  let rejectOpen = $state(false);
  let rejectionReason = $state("");
  let idempotencyKey = $state(crypto.randomUUID());
  let loadedVersionId = $state<string | null>(null);

  async function load() {
    const versionId = page.params.versionId;
    if (!workspace || !detail.skill || !versionId) return;
    loading = true;
    error = null;
    try {
      const selected =
        detail.versions.find((candidate) => candidate.id === page.params.versionId) ??
        (await getSkillVersion(workspace.id, detail.skill.id, versionId));
      version = selected;
      diff = selected.baseVersionId
        ? await getSkillDiff({
            workspaceId: workspace.id,
            skillId: detail.skill.id,
            fromVersionId: selected.baseVersionId,
            toVersionId: selected.id,
          })
        : null;
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The version could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function publish() {
    if (!workspace || !detail.skill || !version) return;
    actionState = "publishing";
    actionError = null;
    try {
      const published = await publishCandidate({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: version.id,
        idempotencyKey,
      });
      version = published;
      detail.replaceVersion(published);
      await detail.refresh();
    } catch (cause) {
      actionError =
        cause instanceof Error
          ? cause.message
          : "The candidate could not be published.";
    } finally {
      actionState = "idle";
    }
  }

  async function reject() {
    if (!workspace || !detail.skill || !version) return;
    actionState = "rejecting";
    actionError = null;
    try {
      const rejected = await rejectCandidate({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: version.id,
        reason: rejectionReason,
        idempotencyKey,
      });
      version = rejected;
      detail.replaceVersion(rejected);
      rejectOpen = false;
    } catch (cause) {
      actionError =
        cause instanceof Error ? cause.message : "The candidate could not be rejected.";
    } finally {
      actionState = "idle";
    }
  }

  async function openFile(path: string) {
    if (!workspace || !detail.skill || !version) return;
    const query = new URLSearchParams({
      version: version.id,
      file: path,
    });
    // The pathname is route-safe via resolve(); only encoded query parameters are appended.
    /* eslint-disable svelte/no-navigation-without-resolve */
    await goto(
      `${resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/content", {
        workspaceSlug: workspace.slug,
        skillSlug: detail.skill.slug,
      })}?${query.toString()}`,
    );
    /* eslint-enable svelte/no-navigation-without-resolve */
  }

  $effect(() => {
    if (detail.skill && workspace && loadedVersionId !== page.params.versionId) {
      loadedVersionId = page.params.versionId ?? null;
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
    href={resolve("/(app)/[workspaceSlug]/skills/[skillSlug]/versions", {
      workspaceSlug: workspace.slug,
      skillSlug: detail.skill.slug,
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
        <p>Immutable revision {version.revision}</p>
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
      <div class="notice success" role="status">
        <CheckCircleIcon weight="fill" aria-hidden="true" />
        Candidate revision {version.revision} was created. Published content remains unchanged
        until approval.
      </div>
    {/if}

    {#if version.status === "pending_review"}
      <section class="review panel">
        <div>
          <p>Publication control</p>
          <h3>Review this human-authored candidate</h3>
          <span>
            Approval assigns the semantic version atomically. A stale base produces a
            typed conflict and leaves the candidate unchanged.
          </span>
        </div>
        {#if canPublish}
          <div class="review-actions">
            <Button
              variant="danger"
              onclick={() => {
                idempotencyKey = crypto.randomUUID();
                rejectOpen = true;
              }}
            >
              Reject
            </Button>
            <Button
              loading={actionState === "publishing"}
              onclick={() => {
                idempotencyKey = crypto.randomUUID();
                void publish();
              }}
            >
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
        kind={actionError.toLocaleLowerCase().includes("conflict")
          ? "conflict"
          : "error"}
        title="Candidate state was not changed"
        message={actionError}
      />
    {/if}

    <section class="metadata panel">
      <header>
        <p>Provenance</p>
        <h3>Immutable metadata</h3>
      </header>
      <dl>
        <div>
          <dt>Revision</dt>
          <dd>{version.revision}</dd>
        </div>
        <div>
          <dt>Semantic version</dt>
          <dd>{version.semanticVersion ?? "Assigned at publication"}</dd>
        </div>
        <div>
          <dt>Source</dt>
          <dd>{version.source.replace("_", " ")}</dd>
        </div>
        <div>
          <dt>Authenticated creator</dt>
          <dd>{version.createdByActorType}:{version.createdByActorId}</dd>
        </div>
        <div>
          <dt>Declared agent</dt>
          <dd>
            {version.createdByAgent
              ? `${version.createdByAgent} / ${version.createdByModel ?? "unknown model"}`
              : "Not agent-authored"}
          </dd>
        </div>
        <div>
          <dt>Proposed bump</dt>
          <dd>{version.proposedBump ?? "Not applicable"}</dd>
        </div>
        <div>
          <dt>Bundle digest</dt>
          <dd>{version.digest}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>
            <time datetime={version.createdAt}>
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "long",
              }).format(new Date(version.createdAt))}
            </time>
          </dd>
        </div>
      </dl>
    </section>

    {#if version.source === "agent_amendment"}
      <section class="panel learning-panel">
        <LearningMetadata metadata={version.learningMetadata} />
      </section>
    {/if}

    <section class="panel manifest">
      <header>
        <p>Bundle</p>
        <h3>{version.manifest.fileCount} verified files</h3>
      </header>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex (A focusable scroll region lets keyboard users inspect the full manifest.) -->
      <div
        class="table-wrap"
        role="region"
        aria-label="Version file manifest"
        tabindex="0"
      >
        <table>
          <thead>
            <tr><th>Path</th><th>Type</th><th>Bytes</th><th>SHA-256</th></tr>
          </thead>
          <tbody>
            {#each version.manifest.files as file (file.path)}
              <tr>
                <td>
                  <button type="button" onclick={() => void openFile(file.path)}>
                    {file.path}
                  </button>
                </td>
                <td>{file.mediaType}</td>
                <td>{file.byteSize.toLocaleString()}</td>
                <td title={file.sha256}>{file.sha256.slice(0, 16)}…</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel diff-panel">
      <header>
        <p>Changes</p>
        <h3>
          {#if diff}
            <GitDiffIcon weight="duotone" aria-hidden="true" />
            Diff from base revision
          {:else}
            Initial version
          {/if}
        </h3>
      </header>
      {#if diff}
        <VersionDiff files={diff.files} />
      {:else}
        <SkillState
          kind="empty"
          title="Initial published bundle"
          message="Revision 1 has no earlier base version to compare."
        />
      {/if}
    </section>

    <Dialog
      bind:open={rejectOpen}
      title="Reject candidate revision"
      description="The immutable candidate and its reason remain in version history. Published content is preserved."
    >
      <Input
        label="Rejection reason"
        required
        minlength={1}
        maxlength={2000}
        bind:value={rejectionReason}
        data-autofocus
      />
      {#snippet footer()}
        <Button variant="secondary" onclick={() => (rejectOpen = false)}>Cancel</Button>
        <Button
          variant="danger"
          disabled={!rejectionReason.trim()}
          loading={actionState === "rejecting"}
          onclick={() => void reject()}
        >
          Reject candidate
        </Button>
      {/snippet}
    </Dialog>
  {/if}
{/if}

<style>
  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    margin-bottom: var(--sp-space-4);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  .version-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
    margin-bottom: var(--sp-space-4);
  }

  .version-heading p,
  h2,
  .version-heading span,
  .panel header p,
  h3 {
    display: block;
    margin: 0;
  }

  .version-heading p,
  .panel header p {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  h2 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-6);
  }

  .version-heading span,
  .review span {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .panel {
    margin-top: var(--sp-space-4);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-4);
    background: var(--sp-color-surface);
  }

  .review {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--sp-space-5);
    border-color: var(--sp-color-warning);
    background: var(--sp-color-warning-soft);
  }

  .review p {
    margin: 0;
    color: var(--sp-color-warning);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    text-transform: uppercase;
  }

  .review h3 {
    margin-top: var(--sp-space-1);
  }

  .review-actions {
    display: flex;
    flex: none;
    gap: var(--sp-space-2);
  }

  .notice {
    display: flex;
    gap: var(--sp-space-2);
    align-items: flex-start;
    margin-bottom: var(--sp-space-4);
    border: 1px solid var(--sp-color-success);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-3);
  }

  .metadata dl {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--sp-space-4);
    margin: var(--sp-space-4) 0 0;
  }

  .metadata dt {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  .metadata dl > div,
  .metadata dd {
    min-width: 0;
  }

  .metadata dd {
    overflow: hidden;
    margin: var(--sp-space-1) 0 0;
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .manifest > header,
  .diff-panel > header {
    margin-bottom: var(--sp-space-3);
  }

  .diff-panel h3 {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin-top: var(--sp-space-1);
  }

  .table-wrap {
    overflow: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--sp-font-size-2);
  }

  th,
  td {
    padding: var(--sp-space-2) var(--sp-space-3);
    border-bottom: 1px solid var(--sp-color-border);
    text-align: left;
    white-space: nowrap;
  }

  th {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    text-transform: uppercase;
  }

  td button {
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--sp-color-accent-text);
    cursor: pointer;
    font-family: var(--sp-font-mono);
  }

  td:last-child {
    max-width: 12rem;
    overflow: hidden;
    font-family: var(--sp-font-mono);
    text-overflow: ellipsis;
  }

  @media (max-width: 48rem) {
    .review {
      display: grid;
    }

    .metadata dl {
      grid-template-columns: 1fr 1fr;
    }
  }

  @media (max-width: 32rem) {
    .metadata dl {
      grid-template-columns: 1fr;
    }
  }
</style>
