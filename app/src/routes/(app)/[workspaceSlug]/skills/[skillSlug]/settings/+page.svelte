<script lang="ts">
  import { resolve } from "$app/paths";
  import { page } from "$app/state";
  import { Button, Dialog, Select, Toast } from "@skillplane/ui";
  import PolicyEditor from "$lib/skills/PolicyEditor.svelte";
  import SkillState from "$lib/skills/SkillState.svelte";
  import { setSkillArchived, setSkillVisibility } from "$lib/skills/api.js";
  import { useSkillDetailStore } from "$lib/skills/store.svelte.js";
  import type { SkillVisibility } from "$lib/skills/types.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    ArchiveIcon,
    ArrowCounterClockwiseIcon,
    GlobeHemisphereWestIcon,
    LockKeyIcon,
    ShieldCheckIcon,
  } from "phosphor-svelte";

  const detail = useSkillDetailStore();
  const workspaces = useWorkspaceStore();
  const workspace = $derived(
    workspaces.workspaces.find(
      (candidate) => candidate.slug === page.params.workspaceSlug,
    ) ?? null,
  );
  const canWrite = $derived(Boolean(workspace && workspace.role !== "viewer"));
  const canManagePolicy = $derived(
    Boolean(workspace && (workspace.role === "admin" || workspace.role === "owner")),
  );
  let visibility = $state<SkillVisibility>("workspace");
  let loadedSkillId = $state<string | null>(null);
  let action = $state<"idle" | "visibility" | "archive" | "restore">("idle");
  let error = $state<string | null>(null);
  let archiveOpen = $state(false);
  let idempotencyKey = $state(crypto.randomUUID());
  let toast = $state<{
    title: string;
    message: string;
  } | null>(null);

  $effect(() => {
    if (detail.skill && detail.skill.id !== loadedSkillId) {
      loadedSkillId = detail.skill.id;
      visibility = detail.skill.visibility;
      error = null;
    }
  });

  async function saveVisibility() {
    if (!workspace || !detail.skill || !canWrite) return;
    action = "visibility";
    error = null;
    try {
      const updated = await setSkillVisibility({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        visibility,
        idempotencyKey,
      });
      detail.replaceSkill(updated);
      idempotencyKey = crypto.randomUUID();
      toast = {
        title: "Visibility updated",
        message:
          visibility === "public"
            ? "The published version now has a shareable public page."
            : "The new access boundary is active for UI and direct API requests.",
      };
    } catch (cause) {
      error =
        cause instanceof Error ? cause.message : "Visibility could not be updated.";
    } finally {
      action = "idle";
    }
  }

  async function changeArchiveState(archived: boolean) {
    if (!workspace || !detail.skill || !canWrite) return;
    action = archived ? "archive" : "restore";
    error = null;
    try {
      const updated = await setSkillArchived({
        workspaceId: workspace.id,
        skillId: detail.skill.id,
        archived,
        idempotencyKey,
      });
      detail.replaceSkill(updated);
      idempotencyKey = crypto.randomUUID();
      archiveOpen = false;
      toast = {
        title: archived ? "Skill archived" : "Skill restored",
        message: archived
          ? "Discovery and the public page are disabled. Immutable versions remain available to workspace members."
          : "The skill is active again with its published version history intact.",
      };
    } catch (cause) {
      error =
        cause instanceof Error
          ? cause.message
          : `The skill could not be ${archived ? "archived" : "restored"}.`;
    } finally {
      action = "idle";
    }
  }
</script>

<svelte:head>
  <title>Settings · {detail.skill?.name ?? "Skillplane"}</title>
</svelte:head>

{#if detail.skill && workspace}
  <div class="settings-grid">
    <section class="panel">
      <header>
        <div class="panel-icon" aria-hidden="true">
          <LockKeyIcon weight="duotone" />
        </div>
        <div>
          <h2>Visibility</h2>
          <p>Control who can discover and retrieve the published version.</p>
        </div>
      </header>

      <div class="form-row">
        <div>
          <Select
            label="Skill visibility"
            description="Private is limited to explicit access; workspace is available to members; public creates an unauthenticated share page."
            options={[
              { value: "private", label: "Private" },
              { value: "workspace", label: "Workspace" },
              { value: "public", label: "Public" },
            ]}
            bind:value={visibility}
            disabled={!canWrite || Boolean(detail.skill.archivedAt)}
          />
        </div>
        <Button
          variant="primary"
          loading={action === "visibility"}
          disabled={!canWrite ||
            Boolean(detail.skill.archivedAt) ||
            visibility === detail.skill.visibility ||
            action !== "idle"}
          onclick={() => void saveVisibility()}
        >
          Save visibility
        </Button>
      </div>

      {#if detail.skill.visibility === "public" && !detail.skill.archivedAt}
        <div class="public-link">
          <GlobeHemisphereWestIcon weight="fill" aria-hidden="true" />
          <span>
            Public retrieval is active.
            <a
              href={resolve("/skills/[workspaceSlug]/[skillSlug]", {
                workspaceSlug: workspace.slug,
                skillSlug: detail.skill.slug,
              })}
            >
              Open share page
            </a>
          </span>
        </div>
      {/if}
    </section>

    <section class="panel">
      <header>
        <div class="panel-icon" aria-hidden="true">
          <ShieldCheckIcon weight="duotone" />
        </div>
        <div>
          <h2>Amendment policy</h2>
          <p>How agent-proposed improvements reach the published skill.</p>
        </div>
      </header>
      <div class="policy">
        <PolicyEditor
          workspaceId={workspace.id}
          skillId={detail.skill.id}
          canManage={canManagePolicy}
        />
      </div>
    </section>

    <section class="panel lifecycle">
      <header>
        <div class="panel-icon" aria-hidden="true">
          <ArchiveIcon weight="duotone" />
        </div>
        <div>
          <h2>Lifecycle</h2>
          <p>Remove a skill from discovery without deleting its history.</p>
        </div>
      </header>
      <div class="lifecycle-row">
        <div>
          <strong>{detail.skill.archivedAt ? "Archived" : "Active"}</strong>
          <p>
            {detail.skill.archivedAt
              ? "The skill is hidden from active discovery and public retrieval."
              : "The skill can be retrieved according to its visibility."}
          </p>
        </div>
        {#if canWrite}
          {#if detail.skill.archivedAt}
            <Button
              loading={action === "restore"}
              disabled={action !== "idle"}
              onclick={() => void changeArchiveState(false)}
            >
              {#snippet leading()}
                <ArrowCounterClockwiseIcon weight="bold" />
              {/snippet}
              Restore skill
            </Button>
          {:else}
            <Button
              variant="danger"
              disabled={action !== "idle"}
              onclick={() => (archiveOpen = true)}
            >
              {#snippet leading()}<ArchiveIcon weight="bold" />{/snippet}
              Archive skill
            </Button>
          {/if}
        {/if}
      </div>
    </section>

    {#if !canWrite}
      <SkillState
        kind="empty"
        title="Viewer access"
        message="You can inspect settings, but only editors, admins, and owners can change this skill."
      />
    {/if}

    {#if error}
      <SkillState kind="error" title="Settings were not saved" message={error} />
    {/if}
  </div>

  <Dialog
    bind:open={archiveOpen}
    title="Archive this skill?"
    description="This immediately disables active discovery and public retrieval. Published versions are preserved and the skill can be restored."
  >
    <p class="dialog-copy">
      Agents using a saved skill identifier will receive an archived-resource error.
      Context knowledge and every immutable version remain intact.
    </p>
    {#snippet footer()}
      <Button disabled={action !== "idle"} onclick={() => (archiveOpen = false)}>
        Cancel
      </Button>
      <Button
        variant="danger"
        loading={action === "archive"}
        disabled={action !== "idle"}
        onclick={() => void changeArchiveState(true)}
      >
        Archive skill
      </Button>
    {/snippet}
  </Dialog>

  {#if toast}
    <div class="toast-region" aria-live="polite">
      <Toast
        title={toast.title}
        message={toast.message}
        tone="success"
        onDismiss={() => (toast = null)}
      />
    </div>
  {/if}
{/if}

<style>
  .settings-grid {
    display: grid;
    gap: var(--sp-space-4);
  }

  .panel {
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
  }

  .panel > header {
    display: flex;
    gap: var(--sp-space-3);
    align-items: flex-start;
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }

  .panel-icon {
    display: grid;
    width: 2rem;
    height: 2rem;
    flex: none;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  h2,
  p,
  strong {
    margin: 0;
  }

  h2 {
    font-size: var(--sp-font-size-4);
  }

  header p,
  .lifecycle-row p {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  .form-row,
  .lifecycle-row {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: var(--sp-space-4);
    align-items: end;
    padding: var(--sp-space-4);
  }

  .public-link {
    display: flex;
    gap: var(--sp-space-2);
    align-items: center;
    margin: 0 var(--sp-space-4) var(--sp-space-4);
    border: 1px solid var(--sp-color-success);
    border-radius: var(--sp-radius-md);
    padding: var(--sp-space-3);
    background: var(--sp-color-success-soft);
    color: var(--sp-color-success);
    font-size: var(--sp-font-size-3);
  }

  .public-link a {
    color: inherit;
    font-weight: var(--sp-weight-semibold);
  }

  .policy {
    padding: var(--sp-space-4);
  }

  .lifecycle {
    border-color: color-mix(
      in srgb,
      var(--sp-color-warning) 48%,
      var(--sp-color-border)
    );
  }

  .dialog-copy {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: var(--sp-line-normal);
  }

  .toast-region {
    position: fixed;
    z-index: 70;
    right: var(--sp-space-5);
    bottom: var(--sp-space-5);
  }

  @media (max-width: 40rem) {
    .form-row,
    .lifecycle-row {
      grid-template-columns: 1fr;
      align-items: start;
    }

    .lifecycle-row :global(button),
    .form-row :global(button) {
      width: 100%;
    }

    .toast-region {
      right: var(--sp-space-3);
      bottom: var(--sp-space-3);
    }
  }
</style>
