<script lang="ts">
  import { apiRequest, jsonBody, SkillplaneApiError } from "$lib/api/client.js";
  import AsyncState from "$lib/components/AsyncState.svelte";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    BuildingsIcon as Buildings,
    CheckCircleIcon as CheckCircle,
    PlusIcon as Plus,
    UserCircleIcon as UserCircle,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";

  const store = useWorkspaceStore();
  let createOpen = $state(false);
  let createName = $state("");
  let createSlug = $state("");
  let createRegionId = $state("");
  let createState = $state<"idle" | "saving">("idle");
  let createError = $state<string | null>(null);
  let savedMessage = $state<string | null>(null);
  let editName = $state("");
  let editSlug = $state("");
  let editState = $state<"idle" | "saving">("idle");
  let editError = $state<string | null>(null);

  $effect(() => {
    editName = store.active?.name ?? "";
    editSlug = store.active?.slug ?? "";
    editError = null;
  });

  $effect(() => {
    if (createOpen && !createRegionId && store.recommendedRegionId) {
      createRegionId = store.recommendedRegionId;
    }
  });

  function slugFromName() {
    if (!createSlug || createSlug === createName.slice(0, -1)) {
      createSlug = createName
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
    }
  }

  async function createWorkspace(event: SubmitEvent) {
    event.preventDefault();
    createState = "saving";
    createError = null;
    try {
      const data = await apiRequest<{
        workspace: { id: string; name: string };
      }>("/api/v1/workspaces", {
        method: "POST",
        ...jsonBody({
          name: createName,
          slug: createSlug,
          regionId: createRegionId,
        }),
      });
      await store.refresh(data.workspace.id);
      createOpen = false;
      createName = "";
      createSlug = "";
      createRegionId = "";
      savedMessage = `${data.workspace.name} was created.`;
    } catch (error) {
      createError =
        error instanceof SkillplaneApiError
          ? error.message
          : "The workspace could not be created.";
    } finally {
      createState = "idle";
    }
  }

  async function updateWorkspace(event: SubmitEvent) {
    event.preventDefault();
    const active = store.active;
    if (!active) return;
    editState = "saving";
    editError = null;
    try {
      const data = await apiRequest<{
        workspace: { id: string; name: string };
      }>(`/api/v1/workspaces/${encodeURIComponent(active.id)}`, {
        method: "PATCH",
        ...jsonBody({ name: editName, slug: editSlug }),
      });
      await store.refresh(active.id);
      savedMessage = `${data.workspace.name} was updated.`;
    } catch (error) {
      editError =
        error instanceof SkillplaneApiError
          ? error.message
          : "The workspace could not be updated.";
    } finally {
      editState = "idle";
    }
  }
</script>

<svelte:head>
  <title>Workspaces · Skillplane</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div>
      <p class="eyebrow">Organization</p>
      <h1>Workspaces</h1>
      <p>Separate personal skills from shared organization knowledge.</p>
    </div>
    <button class="primary" type="button" onclick={() => (createOpen = !createOpen)}>
      <Plus size={16} weight="bold" aria-hidden="true" /> New workspace
    </button>
  </header>

  {#if savedMessage}
    <div class="notice success" role="status">
      <CheckCircle size={17} weight="fill" aria-hidden="true" />
      {savedMessage}
      <button
        type="button"
        aria-label="Dismiss success message"
        onclick={() => (savedMessage = null)}
      >
        ×
      </button>
    </div>
  {/if}

  {#if createOpen}
    <section class="panel create-panel" aria-labelledby="create-title">
      <div>
        <p class="section-label">Create organization</p>
        <h2 id="create-title">A dedicated workspace for your team</h2>
      </div>
      <form onsubmit={createWorkspace}>
        <label>
          <span>Name</span>
          <input
            required
            maxlength="120"
            autocomplete="organization"
            bind:value={createName}
            oninput={slugFromName}
            aria-describedby={createError ? "create-error" : undefined}
          />
        </label>
        <fieldset>
          <legend>Data region</legend>
          <p class="field-help">
            Choose where this workspace's private data and execution will live. This
            cannot be changed without a managed workspace move.
          </p>
          <div class="region-options">
            {#each store.regions as region (region.id)}
              <label class:recommended={region.id === store.recommendedRegionId}>
                <input
                  required
                  type="radio"
                  name="workspace-region"
                  value={region.id}
                  bind:group={createRegionId}
                />
                <span>
                  <strong>{region.name}</strong>
                  <small>{region.id}</small>
                </span>
                {#if region.id === store.recommendedRegionId}
                  <em>Recommended</em>
                {/if}
              </label>
            {/each}
          </div>
        </fieldset>
        <label>
          <span>Workspace URL</span>
          <div class="slug-input">
            <small>skillplane.dev/</small>
            <input required minlength="2" maxlength="63" bind:value={createSlug} />
          </div>
        </label>
        {#if createError}
          <p class="form-error" id="create-error" role="alert">
            <WarningCircle size={16} weight="fill" aria-hidden="true" />
            {createError}
          </p>
        {/if}
        <div class="actions">
          <button class="secondary" type="button" onclick={() => (createOpen = false)}
            >Cancel</button
          >
          <button class="primary" type="submit" disabled={createState === "saving"}>
            {createState === "saving" ? "Creating…" : "Create workspace"}
          </button>
        </div>
      </form>
    </section>
  {/if}

  {#if store.loading}
    <div class="skeleton-grid" aria-label="Loading workspaces" aria-busy="true">
      <span></span><span></span><span></span>
    </div>
  {:else if store.error}
    <AsyncState
      title="Workspaces could not be loaded"
      message={store.error}
      retry={() => void store.load()}
    />
  {:else if store.workspaces.length === 0}
    <AsyncState
      title="No workspace is available"
      message="Retry personal workspace setup. If this continues, contact support with the request reference."
      retry={() => void store.load()}
    />
  {:else}
    <section class="workspace-grid" aria-label="Your workspaces">
      {#each store.workspaces as workspace (workspace.id)}
        <button
          class:active={workspace.id === store.activeId}
          type="button"
          onclick={() => store.select(workspace.id)}
          aria-pressed={workspace.id === store.activeId}
        >
          <span class="workspace-icon">
            {#if workspace.kind === "personal"}
              <UserCircle size={20} weight="duotone" aria-hidden="true" />
            {:else}
              <Buildings size={20} weight="duotone" aria-hidden="true" />
            {/if}
          </span>
          <span class="workspace-copy">
            <strong>{workspace.name}</strong>
            <small>{workspace.kind} · {workspace.role}</small>
          </span>
          <span class="selected-dot" aria-hidden="true"></span>
        </button>
      {/each}
    </section>

    {#if store.active}
      <section class="panel settings" aria-labelledby="settings-title">
        <div class="panel-heading">
          <div>
            <p class="section-label">Selected workspace</p>
            <h2 id="settings-title">General settings</h2>
          </div>
          <span class="role-badge">{store.active.role}</span>
        </div>
        <form onsubmit={updateWorkspace}>
          <label>
            <span>Name</span>
            <input
              required
              maxlength="120"
              bind:value={editName}
              disabled={!["admin", "owner"].includes(store.active.role)}
              aria-describedby={editError ? "edit-error" : undefined}
            />
          </label>
          <label>
            <span>Workspace URL</span>
            <div class="slug-input">
              <small>skillplane.dev/</small>
              <input
                required
                minlength="2"
                maxlength="63"
                bind:value={editSlug}
                disabled={!["admin", "owner"].includes(store.active.role)}
              />
            </div>
          </label>
          {#if editError}
            <p class="form-error" id="edit-error" role="alert">
              <WarningCircle size={16} weight="fill" aria-hidden="true" />
              {editError}
            </p>
          {/if}
          {#if ["admin", "owner"].includes(store.active.role)}
            <div class="actions end">
              <button class="primary" type="submit" disabled={editState === "saving"}>
                {editState === "saving" ? "Saving…" : "Save changes"}
              </button>
            </div>
          {:else}
            <p class="permission-note">
              Your {store.active.role} role can view these settings. An admin or owner can
              make changes.
            </p>
          {/if}
        </form>
      </section>
    {/if}
  {/if}
</main>

<style>
  .page {
    width: min(100% - 2.5rem, 72rem);
    margin: 0 auto;
    padding: 3.25rem 0 5rem;
  }

  .page-header,
  .panel-heading,
  .actions {
    display: flex;
    gap: 1rem;
    align-items: center;
    justify-content: space-between;
  }

  .page-header {
    align-items: flex-end;
    margin-bottom: 2rem;
  }

  .eyebrow,
  .section-label {
    margin: 0 0 0.45rem;
    color: var(--text-tertiary);
    font-size: 0.66rem;
    font-weight: 720;
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  h1,
  h2,
  .page-header p {
    margin: 0;
  }

  h1 {
    font-size: clamp(1.65rem, 4vw, 2.15rem);
    font-weight: 640;
    letter-spacing: -0.035em;
  }

  h2 {
    font-size: 1rem;
  }

  .page-header > div > p:last-child {
    margin-top: 0.5rem;
    color: var(--text-secondary);
    font-size: 0.86rem;
  }

  button {
    cursor: pointer;
  }

  .primary,
  .secondary {
    display: inline-flex;
    min-height: 2.3rem;
    gap: 0.45rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.85rem;
    border-radius: 0.45rem;
    font-size: 0.78rem;
    font-weight: 650;
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--sp-color-surface);
  }

  .primary:hover {
    background: var(--accent-hover);
  }

  .secondary {
    border: 1px solid var(--border);
    background: var(--surface-subtle);
    color: var(--text);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .notice {
    display: flex;
    gap: 0.55rem;
    align-items: center;
    margin: -0.75rem 0 1.2rem;
    padding: 0.75rem 0.9rem;
    border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border));
    border-radius: 0.55rem;
    background: color-mix(in srgb, var(--success) 8%, var(--surface));
    color: var(--success);
    font-size: 0.78rem;
  }

  .notice button {
    margin-left: auto;
    border: 0;
    background: transparent;
    color: inherit;
    font-size: 1.1rem;
  }

  .workspace-grid,
  .skeleton-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin-bottom: 1.35rem;
  }

  .workspace-grid > button {
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: 0.7rem;
    align-items: center;
    padding: 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.65rem;
    background: var(--surface);
    color: var(--text);
    text-align: left;
  }

  .workspace-grid > button:hover,
  .workspace-grid > button.active {
    border-color: var(--border-strong);
    background: var(--surface-raised);
  }

  .workspace-grid > button.active {
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .workspace-icon {
    display: grid;
    width: 2.15rem;
    height: 2.15rem;
    place-items: center;
    border-radius: 0.5rem;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .workspace-copy,
  .workspace-copy strong,
  .workspace-copy small {
    display: block;
    min-width: 0;
  }

  .workspace-copy strong {
    overflow: hidden;
    font-size: 0.78rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .workspace-copy small {
    margin-top: 0.22rem;
    color: var(--text-tertiary);
    font-size: 0.66rem;
    text-transform: capitalize;
  }

  .selected-dot {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: transparent;
  }

  button.active .selected-dot {
    background: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .skeleton-grid span {
    height: 4.2rem;
    border-radius: 0.65rem;
    background: linear-gradient(
      90deg,
      var(--surface) 20%,
      var(--surface-subtle) 50%,
      var(--surface) 80%
    );
    background-size: 200% 100%;
    animation: shimmer 1.3s infinite linear;
  }

  .panel {
    padding: 1.2rem;
    border: 1px solid var(--border);
    border-radius: 0.75rem;
    background: var(--surface);
  }

  .create-panel {
    display: grid;
    grid-template-columns: minmax(12rem, 0.65fr) minmax(18rem, 1fr);
    gap: 2rem;
    margin-bottom: 1.35rem;
  }

  .settings {
    margin-top: 1rem;
  }

  .settings .panel-heading {
    margin-bottom: 1.15rem;
    padding-bottom: 1rem;
    border-bottom: 1px solid var(--border);
  }

  form {
    display: grid;
    gap: 0.9rem;
  }

  label > span,
  legend {
    display: block;
    margin-bottom: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.72rem;
    font-weight: 620;
  }

  fieldset {
    min-width: 0;
    margin: 0;
    padding: 0;
    border: 0;
  }

  legend {
    padding: 0;
  }

  .field-help {
    margin: 0 0 0.55rem;
    color: var(--text-tertiary);
    font-size: 0.7rem;
    line-height: 1.45;
  }

  .region-options {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.55rem;
  }

  .region-options label {
    position: relative;
    display: grid;
    min-width: 0;
    grid-template-columns: auto minmax(0, 1fr);
    gap: 0.55rem;
    align-items: center;
    padding: 0.7rem;
    border: 1px solid var(--border);
    border-radius: 0.55rem;
    background: var(--background);
    cursor: pointer;
  }

  .region-options label:has(input:checked) {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }

  .region-options input {
    width: 1rem;
    height: 1rem;
    padding: 0;
    accent-color: var(--accent);
  }

  .region-options span,
  .region-options strong,
  .region-options small {
    display: block;
    min-width: 0;
  }

  .region-options strong {
    font-size: 0.75rem;
  }

  .region-options small {
    margin-top: 0.15rem;
    color: var(--text-tertiary);
    font-size: 0.64rem;
  }

  .region-options em {
    grid-column: 2;
    color: var(--accent-text);
    font-size: 0.61rem;
    font-style: normal;
    font-weight: 680;
  }

  input {
    width: 100%;
    height: 2.35rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    outline: 0;
    background: var(--background);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.78rem;
  }

  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  input:disabled {
    color: var(--text-tertiary);
  }

  .slug-input {
    display: flex;
    align-items: center;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--background);
  }

  .slug-input:focus-within {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  .slug-input small {
    padding-left: 0.65rem;
    color: var(--text-tertiary);
    font-size: 0.72rem;
  }

  .slug-input input {
    border: 0;
    box-shadow: none;
  }

  .form-error {
    display: flex;
    gap: 0.45rem;
    align-items: flex-start;
    margin: 0;
    color: var(--danger);
    font-size: 0.75rem;
  }

  .actions {
    justify-content: flex-start;
    margin-top: 0.25rem;
  }

  .actions.end {
    justify-content: flex-end;
  }

  .role-badge {
    padding: 0.3rem 0.5rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-secondary);
    font-size: 0.65rem;
    text-transform: capitalize;
  }

  .permission-note {
    margin: 0;
    color: var(--text-tertiary);
    font-size: 0.76rem;
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  @media (max-width: 760px) {
    .page {
      width: min(100% - 1.5rem, 72rem);
      padding-top: 1.5rem;
    }

    .page-header {
      display: grid;
      align-items: start;
    }

    .page-header .primary {
      width: max-content;
    }

    .workspace-grid,
    .skeleton-grid {
      grid-template-columns: 1fr;
    }

    .create-panel {
      grid-template-columns: 1fr;
      gap: 1rem;
    }

    .region-options {
      grid-template-columns: 1fr;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton-grid span {
      animation: none;
    }
  }
</style>
