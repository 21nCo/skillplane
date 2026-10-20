<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Button, Input, Select, Textarea } from "@skillplane/ui";
  import MarkdownEditor from "$lib/markdown/MarkdownEditor.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { createSkill } from "$lib/skills/api.js";
  import {
    buildInstructionsBundle,
    bytesToBase64,
    slugFromName,
  } from "$lib/skills/bundle.js";
  import type { SkillVisibility } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowLeftIcon, WarningCircleIcon } from "phosphor-svelte";

  // Creation lives under "-", which is never a valid slug, so every document slug,
  // including "new", keeps its own route.
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(Boolean(workspace && workspace.role !== "viewer"));

  let name = $state("");
  let slug = $state("");
  let description = $state("");
  let document = $state(
    "# Agent instructions\n\n## Conventions\n\n- Describe how agents should work in this workspace.\n",
  );
  // Instructions are never public.
  let visibility = $state<Extract<SkillVisibility, "private" | "workspace">>("private");
  let saving = $state(false);
  let error = $state<string | null>(null);
  let idempotencyKey = $state(crypto.randomUUID());

  function changed() {
    idempotencyKey = crypto.randomUUID();
    error = null;
  }

  // The slug follows the name until it is typed by hand; clearing it resumes that.
  let slugEdited = false;

  function deriveSlug() {
    if (!slugEdited) slug = slugFromName(name);
    changed();
  }

  function editSlug() {
    slugEdited = slug !== "";
    changed();
  }

  // The request is built from one snapshot taken before any await; the form is
  // disabled until it settles, so a later edit cannot mix into it.
  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!workspace || saving) return;
    const submission = {
      workspace: { id: workspace.id, slug: workspace.slug },
      metadata: { name, slug, description, tags: [] },
      document,
      visibility,
      idempotencyKey,
    };
    saving = true;
    error = null;
    try {
      const bundle = await buildInstructionsBundle({
        metadata: submission.metadata,
        document: submission.document,
      });
      const created = await createSkill({
        workspaceId: submission.workspace.id,
        bundleBase64: bytesToBase64(bundle),
        visibility: submission.visibility,
        idempotencyKey: submission.idempotencyKey,
      });
      // The pathname is route-safe via resolve(); the static success flag is appended.
      /* eslint-disable svelte/no-navigation-without-resolve */
      await goto(
        `${resolve("/(app)/[workspaceSlug]/instructions/[instructionsSlug]", {
          workspaceSlug: submission.workspace.slug,
          instructionsSlug: created.skill.slug,
        })}?created=true`,
      );
      /* eslint-enable svelte/no-navigation-without-resolve */
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : "The instructions could not be created.";
    } finally {
      saving = false;
    }
  }
</script>

<svelte:head>
  <title>New instructions · {workspace?.name ?? "Skillplane"}</title>
</svelte:head>

<main class="new-page">
  <a
    class="back"
    href={resolve("/(app)/[workspaceSlug]/instructions", {
      workspaceSlug: page.params.workspaceSlug ?? "",
    })}
  >
    <ArrowLeftIcon weight="bold" aria-hidden="true" /> Instructions
  </a>

  <header>
    <p>New instructions</p>
    <h1>Write an AGENTS.md document</h1>
  </header>

  {#if !canWrite}
    <SkillState
      kind="authorization"
      title="Editor access required"
      message="Your viewer role can inspect published instructions but cannot create them."
    />
  {:else}
    <form class="panel" onsubmit={submit}>
      <fieldset disabled={saving}>
        <div class="two-column">
          <div>
            <Input
              label="Name"
              placeholder="Repository conventions"
              required
              maxlength={160}
              bind:value={name}
              oninput={deriveSlug}
            />
          </div>
          <div>
            <Input
              label="Slug"
              description="Unique across skills and instructions in this workspace."
              placeholder="repository-conventions"
              required
              maxlength={120}
              pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
              bind:value={slug}
              oninput={editSlug}
            />
          </div>
        </div>
        <Textarea
          label="Description"
          rows={2}
          maxlength={20000}
          bind:value={description}
          oninput={changed}
        />
        <MarkdownEditor
          surface="instructions-create"
          label="AGENTS.md"
          description="The instructions document delivered to agents."
          rows={18}
          required
          maxBytes={1_048_576}
          maxCharacters={1_048_576}
          disabled={saving}
          bind:value={document}
          oninput={changed}
        />
        <Select
          label="Visibility"
          description="Instructions are never public."
          options={[
            { value: "private", label: "Private — only you and authorized principals" },
            { value: "workspace", label: "Workspace — all workspace members" },
          ]}
          bind:value={visibility}
          onchange={changed}
        />
        {#if error}
          <p class="error" role="alert">
            <WarningCircleIcon weight="fill" aria-hidden="true" />
            {error}
          </p>
        {/if}
        <div class="actions">
          <Button type="submit" loading={saving} disabled={saving}>
            Publish version 1.0.0
          </Button>
        </div>
      </fieldset>
    </form>
  {/if}
</main>

<style>
  .new-page {
    width: min(100%, 58rem);
    margin: 0 auto;
    padding: var(--sp-space-6) var(--sp-space-6) var(--sp-space-16);
  }

  .back {
    display: inline-flex;
    align-items: center;
    gap: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    text-decoration: none;
  }

  header {
    margin: var(--sp-space-6) 0 var(--sp-space-4);
  }

  header p,
  h1 {
    margin: 0;
  }

  header p {
    color: var(--sp-color-accent-text);
    font-size: var(--sp-font-size-2);
    font-weight: var(--sp-weight-semibold);
  }

  h1 {
    margin-top: var(--sp-space-1);
    font-size: var(--sp-font-size-7);
    letter-spacing: -0.035em;
  }

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

  .two-column {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-space-4);
  }

  .error {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin: 0;
    color: var(--sp-color-danger);
    font-size: var(--sp-font-size-3);
  }

  .actions {
    display: flex;
    justify-content: flex-end;
  }

  @media (max-width: 48rem) {
    .new-page {
      padding: var(--sp-space-5) var(--sp-space-3) var(--sp-space-12);
    }

    .two-column {
      grid-template-columns: 1fr;
    }
  }
</style>
