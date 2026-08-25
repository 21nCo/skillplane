<script lang="ts">
  import { Button, Select, Textarea } from "@skillplane/ui";
  import { CheckCircleIcon, WarningCircleIcon } from "phosphor-svelte";
  import { SvelteMap } from "svelte/reactivity";
  import { capturePostHog } from "$lib/analytics/posthog.client.js";
  import { createSkillCandidate, getSkillBundle } from "./api.js";
  import { buildSkillBundle, bytesToBase64, filesFromBundle } from "./bundle.js";
  import type { SemanticBump, Skill, SkillVersion } from "./types.js";

  let {
    workspaceId,
    skill,
    baseVersion,
    initialMarkdown,
    onCreated,
  }: {
    workspaceId: string;
    skill: Skill;
    baseVersion: SkillVersion;
    initialMarkdown: string;
    onCreated: (version: SkillVersion) => void;
  } = $props();

  let markdown = $derived(initialMarkdown);
  let changeSummary = $state("");
  let proposedBump = $state<SemanticBump>("patch");
  let saveState = $state<"idle" | "saving">("idle");
  let error = $state<string | null>(null);
  let progress = $state<string | null>(null);
  let idempotencyKey = $state(crypto.randomUUID());

  function changed() {
    idempotencyKey = crypto.randomUUID();
    error = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    saveState = "saving";
    error = null;
    try {
      progress = "Loading the immutable base bundle…";
      const currentBundle = await getSkillBundle({
        workspaceId,
        skillId: skill.id,
        versionId: baseVersion.id,
      });
      const files = new SvelteMap(filesFromBundle(currentBundle));
      files.set("SKILL.md", new TextEncoder().encode(markdown));
      files.delete("skill.json");
      progress = "Validating and packaging the candidate…";
      const candidateBundle = await buildSkillBundle({
        metadata: {
          name: skill.name,
          slug: skill.slug,
          description: skill.description,
          tags: skill.tags,
        },
        files,
      });
      progress = "Writing the immutable candidate…";
      const version = await createSkillCandidate({
        workspaceId,
        skillId: skill.id,
        baseVersionId: baseVersion.id,
        proposedBump,
        changeSummary,
        bundleBase64: bytesToBase64(candidateBundle),
        idempotencyKey,
      });
      progress = null;
      capturePostHog("skill_candidate_created", {
        proposed_bump: version.proposedBump,
      });
      onCreated(version);
    } catch (cause) {
      progress = null;
      error =
        cause instanceof Error
          ? cause.message
          : "The candidate version could not be created.";
    } finally {
      saveState = "idle";
    }
  }
</script>

<form onsubmit={submit}>
  <div class="editor-heading">
    <div>
      <h2>Edit SKILL.md</h2>
      <p>
        Editing creates a new immutable candidate from revision
        {baseVersion.revision}. Published content is never changed in place.
      </p>
    </div>
    <span>
      Base v{baseVersion.semanticVersion ?? `r${String(baseVersion.revision)}`}
    </span>
  </div>

  <Textarea
    label="Skill instructions"
    description="Markdown shown to agents when this skill is retrieved."
    rows={20}
    required
    minlength={1}
    maxlength={1_048_576}
    bind:value={markdown}
    oninput={changed}
  />

  <div class="metadata-grid">
    <Textarea
      label="Change summary"
      description="Explain the user-visible intent of this revision."
      rows={3}
      required
      maxlength={2000}
      bind:value={changeSummary}
      oninput={changed}
    />
    <Select
      label="Proposed semantic bump"
      description="Assigned atomically only when this candidate is published."
      options={[
        { value: "patch", label: "Patch — compatible improvement" },
        { value: "minor", label: "Minor — new compatible capability" },
        { value: "major", label: "Major — breaking behavior" },
      ]}
      bind:value={proposedBump}
      onchange={changed}
    />
  </div>

  {#if progress}
    <p class="progress" role="status">
      <CheckCircleIcon weight="duotone" aria-hidden="true" />
      {progress}
    </p>
  {/if}
  {#if error}
    <p class="error" role="alert">
      <WarningCircleIcon weight="fill" aria-hidden="true" />
      {error}
    </p>
  {/if}

  <div class="actions">
    <Button type="submit" loading={saveState === "saving"}
      >Create candidate version</Button
    >
  </div>
</form>

<style>
  form {
    display: grid;
    gap: var(--sp-space-5);
  }

  .editor-heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--sp-space-4);
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--sp-font-size-5);
  }

  .editor-heading p {
    max-width: 48rem;
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  .editor-heading > span {
    flex: none;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-round);
    padding: var(--sp-space-1) var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .metadata-grid {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(14rem, 1fr);
    gap: var(--sp-space-4);
    align-items: start;
  }

  .progress,
  .error {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-3);
  }

  .error {
    color: var(--sp-color-danger);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 48rem) {
    .metadata-grid {
      grid-template-columns: 1fr;
    }
  }
</style>
