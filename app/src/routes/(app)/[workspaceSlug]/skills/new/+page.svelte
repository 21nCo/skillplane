<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Button, Input, Select, Tabs, Textarea } from "@skillplane/ui";
  import MarkdownEditor from "$lib/markdown/MarkdownEditor.svelte";
  import BundleUploader from "$lib/skills/BundleUploader.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { createSkill } from "$lib/skills/api.js";
  import {
    buildSkillBundle,
    bytesToBase64,
    markdownFiles,
    type InspectedSkillBundle,
  } from "$lib/skills/bundle.js";
  import type { SkillVisibility } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import { ArrowLeftIcon, CheckCircleIcon, WarningCircleIcon } from "phosphor-svelte";

  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(Boolean(workspace && workspace.role !== "viewer"));

  let mode = $state("markdown");
  let name = $state("");
  let slug = $state("");
  let description = $state("");
  let tags = $state("");
  let markdown = $state(
    "# Purpose\n\nExplain what this skill helps an agent accomplish.\n\n## Instructions\n\n1. Add clear, deterministic guidance.\n2. Define important constraints.\n3. Describe the expected output.\n",
  );
  let visibility = $state<SkillVisibility>("private");
  let uploadedBytes = $state<Uint8Array | null>(null);
  let uploadSummary = $state<InspectedSkillBundle | null>(null);
  let saveState = $state<"idle" | "saving">("idle");
  let progress = $state<string | null>(null);
  let error = $state<string | null>(null);
  let idempotencyKey = $state(crypto.randomUUID());

  function deriveSlug() {
    slug = name
      .trim()
      .toLocaleLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "");
    changed();
  }

  function changed() {
    idempotencyKey = crypto.randomUUID();
    error = null;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!workspace) return;
    saveState = "saving";
    error = null;
    try {
      progress =
        mode === "markdown"
          ? "Building and validating the portable bundle…"
          : "Validating the uploaded bundle…";
      const bytes =
        mode === "markdown"
          ? await buildSkillBundle({
              metadata: {
                name,
                slug,
                description,
                tags: tags
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              },
              files: markdownFiles(markdown),
            })
          : uploadedBytes;
      if (!bytes) throw new Error("Choose a valid bundle before publishing.");
      progress = "Writing the immutable bundle and publishing version 1.0.0…";
      const created = await createSkill({
        workspaceId: workspace.id,
        bundleBase64: bytesToBase64(bytes),
        visibility,
        idempotencyKey,
      });
      // The pathname is route-safe via resolve(); the static success flag is appended.
      /* eslint-disable svelte/no-navigation-without-resolve */
      await goto(
        `${resolve("/(app)/[workspaceSlug]/skills/[skillSlug]", {
          workspaceSlug: workspace.slug,
          skillSlug: created.skill.slug,
        })}?created=true`,
      );
      /* eslint-enable svelte/no-navigation-without-resolve */
    } catch (cause) {
      progress = null;
      error =
        cause instanceof Error ? cause.message : "The skill could not be created.";
    } finally {
      saveState = "idle";
    }
  }
</script>

<svelte:head>
  <title>New skill · {workspace?.name ?? "Skillplane"}</title>
</svelte:head>

<main class="new-page">
  {#if workspace}
    <a
      class="back"
      href={resolve("/(app)/[workspaceSlug]/skills", {
        workspaceSlug: workspace.slug,
      })}
    >
      <ArrowLeftIcon weight="bold" aria-hidden="true" /> Skills
    </a>
  {/if}

  <header>
    <p>New skill</p>
    <h1>Create durable agent guidance</h1>
    <span>
      Publish a validated initial bundle, then evolve it through immutable candidate
      revisions.
    </span>
  </header>

  {#if !canWrite}
    <SkillState
      kind="authorization"
      title="Editor access required"
      message="Your viewer role can inspect published skills but cannot create or modify them."
    />
  {:else}
    <form onsubmit={submit}>
      <Tabs
        label="Skill creation method"
        bind:value={mode}
        tabs={[
          { id: "markdown", label: "Author Markdown" },
          { id: "bundle", label: "Upload bundle" },
        ]}
      >
        {#snippet children(active)}
          {#if active === "markdown"}
            <section class="panel">
              <div class="two-column">
                <Input
                  label="Name"
                  placeholder="PR review"
                  required
                  maxlength={160}
                  bind:value={name}
                  oninput={deriveSlug}
                />
                <Input
                  label="Slug"
                  description="Stable identifier used in MCP and URLs."
                  placeholder="pr-review"
                  required
                  maxlength={120}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  bind:value={slug}
                  oninput={changed}
                />
              </div>
              <Textarea
                label="Description"
                description="When should an agent retrieve this skill?"
                rows={3}
                maxlength={20000}
                bind:value={description}
                oninput={changed}
              />
              <Input
                label="Tags"
                description="Comma-separated discovery labels, up to 30."
                placeholder="review, git, quality"
                bind:value={tags}
                oninput={changed}
              />
              <MarkdownEditor
                surface="skill-create"
                label="SKILL.md"
                description="Portable Markdown instructions delivered to agents."
                rows={22}
                required
                maxCharacters={1_048_576}
                bind:value={markdown}
                oninput={changed}
              />
            </section>
          {:else}
            <section class="panel">
              <BundleUploader
                disabled={saveState === "saving"}
                onBundle={(bytes, summary) => {
                  uploadedBytes = bytes;
                  uploadSummary = summary;
                  changed();
                }}
              />
              {#if uploadSummary}
                <dl>
                  <div>
                    <dt>Slug</dt>
                    <dd>{uploadSummary.slug}</dd>
                  </div>
                  <div>
                    <dt>Tags</dt>
                    <dd>{uploadSummary.tags.join(", ") || "None"}</dd>
                  </div>
                </dl>
              {/if}
            </section>
          {/if}
        {/snippet}
      </Tabs>

      <section class="panel publish">
        <Select
          label="Initial visibility"
          description="Visibility can be changed later without rewriting history."
          options={[
            { value: "private", label: "Private — only you and authorized principals" },
            { value: "workspace", label: "Workspace — all workspace members" },
            { value: "public", label: "Public — shareable published page" },
          ]}
          bind:value={visibility}
          onchange={changed}
        />
        <div class="publish-note">
          <CheckCircleIcon weight="duotone" aria-hidden="true" />
          <p>
            Creation publishes revision 1 as semantic version 1.0.0. The bundle,
            manifest, and file digests become immutable.
          </p>
        </div>
      </section>

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

      <div class="form-actions">
        <Button
          href={resolve("/(app)/[workspaceSlug]/skills", {
            workspaceSlug: workspace?.slug ?? page.params.workspaceSlug ?? "",
          })}
          variant="secondary"
        >
          Cancel
        </Button>
        <Button
          type="submit"
          loading={saveState === "saving"}
          disabled={mode === "bundle" && !uploadedBytes}
        >
          Publish version 1.0.0
        </Button>
      </div>
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
    margin: var(--sp-space-6) 0;
  }

  header p,
  h1,
  header span {
    display: block;
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

  header span {
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    line-height: var(--sp-line-normal);
  }

  form {
    display: grid;
    gap: var(--sp-space-4);
  }

  .panel {
    display: grid;
    gap: var(--sp-space-4);
    margin-top: var(--sp-space-4);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    padding: var(--sp-space-5);
    background: var(--sp-color-surface);
  }

  .two-column {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--sp-space-4);
  }

  .publish {
    grid-template-columns: minmax(16rem, 1fr) minmax(0, 1.5fr);
    align-items: center;
  }

  .publish-note {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    gap: var(--sp-space-2);
    color: var(--sp-color-success);
  }

  .publish-note p {
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  dl {
    display: grid;
    gap: var(--sp-space-2);
    margin: 0;
  }

  dl div {
    display: grid;
    grid-template-columns: 6rem minmax(0, 1fr);
  }

  dt {
    color: var(--sp-color-text-subtle);
  }

  dd {
    margin: 0;
  }

  .progress,
  .error {
    display: flex;
    align-items: center;
    gap: var(--sp-space-2);
    margin: 0;
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-3);
  }

  .error {
    color: var(--sp-color-danger);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--sp-space-2);
  }

  @media (max-width: 48rem) {
    .new-page {
      padding: var(--sp-space-5) var(--sp-space-3) var(--sp-space-12);
    }

    .two-column,
    .publish {
      grid-template-columns: 1fr;
    }
  }
</style>
