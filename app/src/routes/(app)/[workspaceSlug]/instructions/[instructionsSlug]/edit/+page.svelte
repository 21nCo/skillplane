<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Button, Select, Textarea } from "@skillplane/ui";
  import MarkdownEditor from "$lib/markdown/MarkdownEditor.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { createSkillCandidate, getInstructionsDocument } from "$lib/skills/api.js";
  import { buildInstructionsBundle, bytesToBase64 } from "$lib/skills/bundle.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type { SemanticBump, SkillVersion } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { WarningCircleIcon } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(Boolean(workspace && workspace.role !== "viewer"));
  // The amendment service rejects candidates for an archived document.
  const archived = $derived(Boolean(detail.skill?.archivedAt));

  let base = $state<SkillVersion | null>(null);
  let document = $state<string | null>(null);
  let loadError = $state<string | null>(null);
  let changeSummary = $state("");
  let proposedBump = $state<SemanticBump>("patch");
  let saving = $state(false);
  let error = $state<string | null>(null);
  let idempotencyKey = $state(crypto.randomUUID());

  function changed() {
    idempotencyKey = crypto.randomUUID();
    error = null;
  }

  // The editor starts from the published document once; a later publication does
  // not overwrite text being edited, and the stale base is reported on submit.
  async function load() {
    const current = detail.currentVersion;
    if (!workspace || !detail.skill || !current) return;
    base = current;
    loadError = null;
    try {
      document = await getInstructionsDocument({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        versionId: current.id,
      });
    } catch (cause) {
      loadError =
        cause instanceof Error ? cause.message : "AGENTS.md could not be loaded.";
    }
  }

  $effect(() => {
    if (!base && detail.currentVersion) void load();
  });

  // The request is built from one snapshot taken before any await; the form is
  // disabled until it settles, so a later edit cannot mix into it.
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const skill = detail.skill;
    if (!workspace || !skill || !base || document === null || saving) return;
    if (skill.archivedAt) {
      error = "Archived instructions cannot be edited.";
      return;
    }
    const submission = {
      workspace: { id: workspace.id, slug: workspace.slug },
      skill: { id: skill.id, slug: skill.slug },
      metadata: {
        name: skill.name,
        slug: skill.slug,
        description: skill.description,
        tags: skill.tags,
      },
      document,
      baseVersionId: base.id,
      proposedBump,
      changeSummary,
      idempotencyKey,
    };
    saving = true;
    error = null;
    try {
      const bundle = await buildInstructionsBundle({
        metadata: submission.metadata,
        document: submission.document,
      });
      const version = await createSkillCandidate({
        workspaceId: submission.workspace.id,
        skillId: submission.skill.id,
        baseVersionId: submission.baseVersionId,
        proposedBump: submission.proposedBump,
        changeSummary: submission.changeSummary,
        bundleBase64: bytesToBase64(bundle),
        idempotencyKey: submission.idempotencyKey,
      });
      detail.replaceVersion(version);
      // The pathname is route-safe via resolve(); the static flag is appended.
      /* eslint-disable svelte/no-navigation-without-resolve */
      await goto(
        `${resolve(
          "/(app)/[workspaceSlug]/instructions/[instructionsSlug]/versions/[versionId]",
          {
            workspaceSlug: submission.workspace.slug,
            instructionsSlug: submission.skill.slug,
            versionId: version.id,
          },
        )}?candidate=true`,
      );
      /* eslint-enable svelte/no-navigation-without-resolve */
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "The candidate could not be created.";
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head>
  <title>Edit · {detail.skill?.name ?? "Instructions"} · Skillplane</title>
</svelte:head>

{#if !canWrite}
  <SkillState
    kind="authorization"
    title="Editor access required"
    message="Your viewer role can inspect instructions but cannot propose changes."
  />
{:else if archived}
  <SkillState
    kind="authorization"
    title="Archived instructions cannot be edited"
    message="Restore the document before proposing a new version."
  />
{:else if loadError}
  <SkillState
    kind="error"
    title="AGENTS.md could not be loaded"
    message={loadError}
    retry={() => void load()}
  />
{:else if document === null || !base}
  <SkillState
    kind="loading"
    title="Loading AGENTS.md"
    message="Loading the published document."
  />
{:else}
  <form class="panel" onsubmit={submit}>
    <fieldset disabled={saving}>
      <header>
        <h2>Edit AGENTS.md</h2>
        <p>
          Submitting creates a candidate based on v{base.semanticVersion}. Published
          content is unchanged until the candidate is approved.
        </p>
      </header>
      <MarkdownEditor
        surface="instructions-revise"
        label="AGENTS.md"
        rows={20}
        required
        maxBytes={1_048_576}
        maxCharacters={1_048_576}
        disabled={saving}
        bind:value={document}
        oninput={changed}
      />
      <div class="two-column">
        <div>
          <Textarea
            label="Change summary"
            required
            rows={2}
            maxlength={2000}
            bind:value={changeSummary}
            oninput={changed}
          />
        </div>
        <div>
          <Select
            label="Proposed semantic bump"
            options={[
              { value: "patch", label: "Patch" },
              { value: "minor", label: "Minor" },
              { value: "major", label: "Major" },
            ]}
            bind:value={proposedBump}
            onchange={changed}
          />
        </div>
      </div>
      {#if error}
        <p class="error" role="alert">
          <WarningCircleIcon weight="fill" aria-hidden="true" />
          {error}
        </p>
      {/if}
      <div class="actions">
        <Button type="submit" loading={saving} disabled={saving}>
          Submit version for review
        </Button>
      </div>
    </fieldset>
  </form>
{/if}

<style>
  .panel {
    display: grid;
    gap: var(--sp-space-4);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
  }

  fieldset {
    display: grid;
    gap: var(--sp-space-4);
    min-width: 0;
    margin: 0;
    border: 0;
    padding: 0;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--sp-font-size-5);
  }

  header p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
  }

  .two-column {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(10rem, 14rem);
    gap: var(--sp-space-4);
    align-items: start;
  }

  .error {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-danger);
    font-size: var(--sp-font-size-3);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 48rem) {
    .two-column {
      grid-template-columns: 1fr;
    }
  }
</style>
