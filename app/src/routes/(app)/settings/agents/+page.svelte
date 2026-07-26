<script lang="ts">
  import { apiRequest, jsonBody, SkillplaneApiError } from "$lib/api/client.js";
  import AsyncState from "$lib/components/AsyncState.svelte";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    CheckIcon as Check,
    CopyIcon as Copy,
    KeyIcon as Key,
    PlusIcon as Plus,
    RobotIcon as Robot,
    ShieldCheckIcon as ShieldCheck,
    WarningCircleIcon as WarningCircle,
    XIcon as X,
  } from "phosphor-svelte";

  type ServiceRole = "viewer" | "editor" | "admin";
  type Scope =
    | "skills:read"
    | "skills:write"
    | "skills:amend"
    | "contexts:read"
    | "contexts:write"
    | "members:read"
    | "members:write"
    | "analytics:read"
    | "audit:read";

  interface ServicePrincipal {
    readonly id: string;
    readonly name: string;
    readonly role: ServiceRole;
    readonly scopes: Scope[];
    readonly delegatedUserId: string | null;
    readonly expiresAt: string | null;
    readonly credentialVersion: number;
    readonly lastUsedAt: string | null;
    readonly revokedAt: string | null;
    readonly createdAt: string;
    readonly updatedAt: string;
  }

  const scopeOptions: readonly { value: Scope; label: string; group: string }[] = [
    { value: "skills:read", label: "Read skills", group: "Skills" },
    { value: "skills:write", label: "Create and update skills", group: "Skills" },
    { value: "skills:amend", label: "Propose amendments", group: "Skills" },
    { value: "contexts:read", label: "Read context knowledge", group: "Contexts" },
    { value: "contexts:write", label: "Maintain context knowledge", group: "Contexts" },
    { value: "members:read", label: "Read members", group: "Workspace" },
    { value: "members:write", label: "Manage members", group: "Workspace" },
    { value: "analytics:read", label: "Read analytics", group: "Insights" },
    { value: "audit:read", label: "Read audit events", group: "Insights" },
  ];

  const store = useWorkspaceStore();
  let agents = $state<ServicePrincipal[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let createOpen = $state(false);
  let name = $state("");
  let role = $state<ServiceRole>("editor");
  let scopes = $state<Scope[]>(["skills:read", "skills:amend", "contexts:read"]);
  let expiresAt = $state("");
  let saving = $state(false);
  let formError = $state<string | null>(null);
  let credential = $state<string | null>(null);
  let credentialFor = $state<string | null>(null);
  let copied = $state(false);
  let actionTarget = $state<{
    agent: ServicePrincipal;
    action: "rotate" | "revoke";
  } | null>(null);

  const canManage = $derived(
    store.active?.role === "owner" || store.active?.role === "admin",
  );

  $effect(() => {
    if (store.activeId) void load();
  });

  async function load() {
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    loading = true;
    error = null;
    try {
      const data = await apiRequest<{ servicePrincipals: ServicePrincipal[] }>(
        `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/service-principals`,
      );
      if (workspaceId === store.activeId) agents = data.servicePrincipals;
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "Agent credentials could not be loaded.";
    } finally {
      loading = false;
    }
  }

  function toggleScope(scope: Scope) {
    scopes = scopes.includes(scope)
      ? scopes.filter((candidate) => candidate !== scope)
      : [...scopes, scope];
  }

  async function createAgent(event: SubmitEvent) {
    event.preventDefault();
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    saving = true;
    formError = null;
    try {
      const data = await apiRequest<{
        servicePrincipal: ServicePrincipal;
        credential: string;
      }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/service-principals`, {
        method: "POST",
        ...jsonBody({
          name,
          role,
          scopes,
          expiresAt: expiresAt
            ? new Date(`${expiresAt}T23:59:59Z`).toISOString()
            : null,
        }),
      });
      credential = data.credential;
      credentialFor = data.servicePrincipal.name;
      copied = false;
      createOpen = false;
      name = "";
      await load();
    } catch (caught) {
      formError =
        caught instanceof SkillplaneApiError
          ? caught.message
          : "The agent credential could not be created.";
    } finally {
      saving = false;
    }
  }

  async function completeAction() {
    const target = actionTarget;
    const workspaceId = store.activeId;
    if (!target || !workspaceId) return;
    actionTarget = null;
    try {
      if (target.action === "rotate") {
        const data = await apiRequest<{
          servicePrincipal: ServicePrincipal;
          credential: string;
        }>(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/service-principals/${encodeURIComponent(target.agent.id)}/rotate`,
          { method: "POST", ...jsonBody({}) },
        );
        credential = data.credential;
        credentialFor = data.servicePrincipal.name;
        copied = false;
      } else {
        await apiRequest(
          `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/service-principals/${encodeURIComponent(target.agent.id)}`,
          { method: "DELETE" },
        );
      }
      await load();
    } catch (caught) {
      error =
        caught instanceof Error ? caught.message : "The credential action failed.";
    }
  }

  async function copyCredential() {
    if (!credential) return;
    await navigator.clipboard.writeText(credential);
    copied = true;
  }
</script>

<svelte:head>
  <title>Agent credentials · Skillplane</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div>
      <p class="eyebrow">Workspace settings</p>
      <h1>Agent credentials</h1>
      <p>Scoped identities for non-interactive AI agents and automation.</p>
    </div>
    {#if canManage}
      <button class="primary" type="button" onclick={() => (createOpen = true)}>
        <Plus size={16} weight="bold" aria-hidden="true" /> New credential
      </button>
    {/if}
  </header>

  <section class="security-note">
    <ShieldCheck size={19} weight="duotone" aria-hidden="true" />
    <div>
      <strong>Least privilege by default</strong>
      <p>
        Each credential has its own role, explicit scopes, optional expiry, and
        immediate revocation. Creator permissions are never inherited.
      </p>
    </div>
  </section>

  {#if createOpen}
    <section class="create-card" aria-labelledby="create-agent-title">
      <div class="card-heading">
        <div>
          <p class="section-label">Service principal</p>
          <h2 id="create-agent-title">Create an agent credential</h2>
        </div>
        <button
          class="icon-button"
          type="button"
          aria-label="Close credential form"
          onclick={() => (createOpen = false)}
          ><X size={16} weight="bold" aria-hidden="true" /></button
        >
      </div>
      <form onsubmit={createAgent}>
        <div class="form-grid">
          <label>
            <span>Name</span>
            <input
              required
              maxlength="120"
              placeholder="PR review bot"
              bind:value={name}
              aria-describedby={formError ? "agent-form-error" : undefined}
            />
          </label>
          <label>
            <span>Workspace role</span>
            <select bind:value={role}>
              <option value="viewer">Viewer</option>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label>
            <span>Expires on <small>(optional)</small></span>
            <input type="date" bind:value={expiresAt} />
          </label>
        </div>
        <fieldset>
          <legend>Scopes</legend>
          <p>Role and scope must both permit an operation.</p>
          <div class="scope-grid">
            {#each scopeOptions as option (option.value)}
              <label class="scope-option">
                <input
                  type="checkbox"
                  checked={scopes.includes(option.value)}
                  onchange={() => toggleScope(option.value)}
                />
                <span>
                  <strong>{option.label}</strong>
                  <small>{option.group} · {option.value}</small>
                </span>
              </label>
            {/each}
          </div>
        </fieldset>
        {#if formError}
          <p class="form-error" id="agent-form-error" role="alert">
            <WarningCircle size={16} weight="fill" aria-hidden="true" />
            {formError}
          </p>
        {/if}
        <div class="actions">
          <button class="secondary" type="button" onclick={() => (createOpen = false)}
            >Cancel</button
          >
          <button
            class="primary"
            type="submit"
            disabled={saving || scopes.length === 0}
          >
            {saving ? "Creating…" : "Create credential"}
          </button>
        </div>
      </form>
    </section>
  {/if}

  {#if loading}
    <section class="list-card" aria-label="Loading agent credentials" aria-busy="true">
      <div class="skeleton"></div>
      <div class="skeleton"></div>
      <div class="skeleton"></div>
    </section>
  {:else if error}
    <AsyncState
      title="Agent credentials could not be loaded"
      message={error}
      retry={() => void load()}
    />
  {:else if agents.length === 0}
    <section class="empty">
      <div><Robot size={26} weight="duotone" aria-hidden="true" /></div>
      <h2>No agent credentials yet</h2>
      <p>
        Create a scoped identity when an agent needs API or MCP access without an
        interactive user session.
      </p>
      {#if canManage}
        <button class="secondary" type="button" onclick={() => (createOpen = true)}>
          <Plus size={15} weight="bold" aria-hidden="true" /> Create the first credential
        </button>
      {/if}
    </section>
  {:else}
    <section class="list-card" aria-label="Service principals">
      <div class="list-heading">
        <div>
          <h2>Service principals</h2>
          <p>{agents.length} configured for {store.active?.name}</p>
        </div>
        <Key size={19} weight="duotone" aria-hidden="true" />
      </div>
      {#each agents as agent (agent.id)}
        <article class:revoked={Boolean(agent.revokedAt)}>
          <div class="agent-icon">
            <Robot size={18} weight="duotone" aria-hidden="true" />
          </div>
          <div class="agent-copy">
            <div>
              <strong>{agent.name}</strong>
              <span class:status-revoked={Boolean(agent.revokedAt)}>
                {agent.revokedAt ? "revoked" : agent.role}
              </span>
            </div>
            <p>{agent.scopes.join(" · ")}</p>
            <small>
              Version {agent.credentialVersion}
              · {agent.lastUsedAt
                ? `last used ${new Date(agent.lastUsedAt).toLocaleString()}`
                : "never used"}
              {agent.expiresAt
                ? ` · expires ${new Date(agent.expiresAt).toLocaleDateString()}`
                : ""}
            </small>
          </div>
          {#if canManage && !agent.revokedAt}
            <div class="row-actions">
              <button
                class="secondary"
                type="button"
                onclick={() => (actionTarget = { agent, action: "rotate" })}
                >Rotate</button
              >
              <button
                class="secondary danger-text"
                type="button"
                onclick={() => (actionTarget = { agent, action: "revoke" })}
                >Revoke</button
              >
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
</main>

{#if credential}
  <div class="dialog-backdrop">
    <dialog open class="dialog credential-dialog" aria-labelledby="credential-title">
      <div class="success-icon">
        <Key size={20} weight="duotone" aria-hidden="true" />
      </div>
      <p class="section-label">One-time secret</p>
      <h2 id="credential-title">Save the credential for {credentialFor}</h2>
      <p>
        This secret will not be shown again. Store it in your agent’s encrypted secret
        manager. Skillplane stores only its hash.
      </p>
      <div class="secret">
        <code>{credential}</code>
        <button type="button" onclick={() => void copyCredential()}>
          {#if copied}<Check size={16} weight="bold" aria-hidden="true" /> Copied{:else}<Copy
              size={16}
              weight="bold"
              aria-hidden="true"
            /> Copy{/if}
        </button>
      </div>
      <button
        class="primary done"
        type="button"
        onclick={() => {
          credential = null;
          credentialFor = null;
          copied = false;
        }}>I have saved it</button
      >
    </dialog>
  </div>
{/if}

{#if actionTarget}
  <div class="dialog-backdrop">
    <dialog
      open
      class="dialog"
      aria-labelledby="action-title"
      aria-describedby="action-description"
    >
      <div class="warning-icon">
        <WarningCircle size={20} weight="duotone" aria-hidden="true" />
      </div>
      <h2 id="action-title">
        {actionTarget.action === "rotate"
          ? "Rotate this credential?"
          : "Revoke this credential?"}
      </h2>
      <p id="action-description">
        {#if actionTarget.action === "rotate"}
          The current secret for {actionTarget.agent.name} will stop working immediately.
          A replacement will be displayed once.
        {:else}
          {actionTarget.agent.name} will immediately lose access. Existing audit history and
          attribution will be preserved.
        {/if}
      </p>
      <div class="actions">
        <button class="secondary" type="button" onclick={() => (actionTarget = null)}
          >Cancel</button
        >
        <button
          class={actionTarget.action === "revoke" ? "danger-button" : "primary"}
          type="button"
          onclick={() => void completeAction()}
        >
          {actionTarget.action === "rotate" ? "Rotate credential" : "Revoke access"}
        </button>
      </div>
    </dialog>
  </div>
{/if}

<style>
  .page {
    width: min(100% - 2.5rem, 72rem);
    margin: 0 auto;
    padding: 3.25rem 0 5rem;
  }

  .page-header,
  .card-heading,
  .list-heading,
  .actions,
  .security-note,
  article {
    display: flex;
    align-items: center;
  }

  .page-header,
  .card-heading,
  .list-heading {
    justify-content: space-between;
  }

  .page-header {
    align-items: flex-end;
    margin-bottom: 1.2rem;
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
  p {
    margin: 0;
  }

  h1 {
    font-size: clamp(1.65rem, 4vw, 2.15rem);
    font-weight: 640;
    letter-spacing: -0.035em;
  }

  h2 {
    font-size: 0.95rem;
  }

  .page-header p:last-child,
  .list-heading p {
    margin-top: 0.4rem;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  button {
    cursor: pointer;
  }

  .primary,
  .secondary,
  .danger-button {
    display: inline-flex;
    min-height: 2.3rem;
    gap: 0.4rem;
    align-items: center;
    justify-content: center;
    padding: 0 0.85rem;
    border-radius: 0.45rem;
    font-size: 0.75rem;
    font-weight: 650;
  }

  .primary {
    border: 1px solid var(--accent);
    background: var(--accent);
    color: var(--sp-color-surface);
  }

  .secondary {
    border: 1px solid var(--border);
    background: var(--surface-subtle);
    color: var(--text);
  }

  .danger-button {
    border: 1px solid var(--danger);
    background: var(--danger);
    color: var(--sp-color-surface);
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.55;
  }

  .security-note {
    gap: 0.7rem;
    margin-bottom: 1rem;
    padding: 0.85rem 1rem;
    border: 1px solid color-mix(in srgb, var(--accent) 30%, var(--border));
    border-radius: 0.65rem;
    background: color-mix(in srgb, var(--accent) 6%, var(--surface));
    color: var(--accent-text);
  }

  .security-note strong {
    font-size: 0.76rem;
  }

  .security-note p {
    margin-top: 0.2rem;
    color: var(--text-secondary);
    font-size: 0.7rem;
    line-height: 1.5;
  }

  .create-card,
  .list-card,
  .empty {
    margin-bottom: 1rem;
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--surface);
  }

  .create-card {
    padding: 1rem;
    box-shadow: 0 1rem 3rem var(--shadow);
  }

  .card-heading {
    margin-bottom: 1rem;
    padding-bottom: 0.9rem;
    border-bottom: 1px solid var(--border);
  }

  .icon-button {
    display: grid;
    width: 2rem;
    height: 2rem;
    place-items: center;
    border: 0;
    border-radius: 0.4rem;
    background: transparent;
    color: var(--text-secondary);
  }

  .icon-button:hover {
    background: var(--surface-subtle);
  }

  form {
    display: grid;
    gap: 1rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: minmax(12rem, 1fr) 10rem 11rem;
    gap: 0.75rem;
  }

  label > span,
  legend {
    display: block;
    margin-bottom: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 620;
  }

  label small {
    color: var(--text-tertiary);
    font-weight: 500;
  }

  input,
  select {
    width: 100%;
    height: 2.3rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    outline: 0;
    background: var(--background);
    color: var(--text);
    padding: 0 0.65rem;
    font-size: 0.75rem;
  }

  input:focus,
  select:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-soft);
  }

  fieldset {
    margin: 0;
    padding: 0.9rem;
    border: 1px solid var(--border);
    border-radius: 0.55rem;
  }

  fieldset > p {
    margin: -0.15rem 0 0.75rem;
    color: var(--text-tertiary);
    font-size: 0.68rem;
  }

  .scope-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.45rem;
  }

  .scope-option {
    display: flex;
    gap: 0.55rem;
    align-items: flex-start;
    min-width: 0;
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.45rem;
    background: var(--background);
    cursor: pointer;
  }

  .scope-option:has(input:checked) {
    border-color: color-mix(in srgb, var(--accent) 55%, var(--border));
    background: var(--accent-soft);
  }

  .scope-option input {
    width: 0.9rem;
    height: 0.9rem;
    margin: 0.08rem 0 0;
    accent-color: var(--accent);
  }

  .scope-option strong,
  .scope-option small {
    display: block;
  }

  .scope-option strong {
    font-size: 0.68rem;
  }

  .scope-option small {
    overflow: hidden;
    margin-top: 0.2rem;
    color: var(--text-tertiary);
    font-size: 0.58rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .form-error {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    color: var(--danger);
    font-size: 0.73rem;
  }

  .actions {
    gap: 0.6rem;
    justify-content: flex-end;
  }

  .list-card {
    overflow: hidden;
  }

  .list-heading {
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }

  article {
    min-height: 5.25rem;
    gap: 0.75rem;
    padding: 0.8rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  article:last-child {
    border-bottom: 0;
  }

  article.revoked {
    opacity: 0.62;
  }

  .agent-icon {
    display: grid;
    width: 2.2rem;
    height: 2.2rem;
    flex: 0 0 auto;
    place-items: center;
    border-radius: 0.5rem;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .agent-copy {
    min-width: 0;
    flex: 1;
  }

  .agent-copy > div {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .agent-copy strong {
    font-size: 0.76rem;
  }

  .agent-copy span {
    padding: 0.2rem 0.4rem;
    border: 1px solid var(--border);
    border-radius: 999px;
    color: var(--text-secondary);
    font-size: 0.58rem;
    text-transform: capitalize;
  }

  .agent-copy span.status-revoked {
    border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
    color: var(--danger);
  }

  .agent-copy p,
  .agent-copy small {
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .agent-copy p {
    margin-top: 0.35rem;
    color: var(--text-secondary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.63rem;
  }

  .agent-copy small {
    margin-top: 0.3rem;
    color: var(--text-tertiary);
    font-size: 0.62rem;
  }

  .row-actions {
    display: flex;
    gap: 0.4rem;
  }

  .row-actions .secondary {
    min-height: 2rem;
    padding: 0 0.65rem;
    font-size: 0.68rem;
  }

  .danger-text {
    color: var(--danger);
  }

  .empty {
    display: grid;
    justify-items: center;
    padding: 3rem 1rem;
    text-align: center;
  }

  .empty > div,
  .success-icon,
  .warning-icon {
    display: grid;
    width: 2.6rem;
    height: 2.6rem;
    place-items: center;
    border-radius: 0.6rem;
  }

  .empty > div,
  .success-icon {
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .empty h2 {
    margin-top: 0.75rem;
  }

  .empty p {
    max-width: 31rem;
    margin-top: 0.4rem;
    color: var(--text-secondary);
    font-size: 0.73rem;
    line-height: 1.6;
  }

  .empty button {
    margin-top: 1rem;
  }

  .skeleton {
    height: 5.2rem;
    border-bottom: 1px solid var(--border);
    background: linear-gradient(
      90deg,
      var(--surface) 20%,
      var(--surface-subtle) 50%,
      var(--surface) 80%
    );
    background-size: 200% 100%;
    animation: shimmer 1.3s infinite linear;
  }

  .dialog-backdrop {
    position: fixed;
    z-index: 50;
    inset: 0;
    display: grid;
    padding: 1rem;
    place-items: center;
    background: rgba(0, 0, 0, 0.68);
  }

  .dialog {
    position: static;
    width: min(100%, 27rem);
    margin: 0;
    padding: 1.25rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.75rem;
    background: var(--surface-raised);
    box-shadow: 0 2rem 6rem rgba(0, 0, 0, 0.45);
  }

  .dialog h2 {
    font-size: 1rem;
  }

  .dialog > p:not(.section-label) {
    margin-top: 0.55rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
    line-height: 1.6;
  }

  .warning-icon {
    margin-bottom: 0.9rem;
    background: var(--danger-soft);
    color: var(--danger);
  }

  .credential-dialog {
    width: min(100%, 34rem);
  }

  .credential-dialog .success-icon {
    margin-bottom: 0.9rem;
  }

  .secret {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 0.5rem;
    align-items: center;
    margin-top: 1rem;
    padding: 0.6rem;
    border: 1px solid var(--border);
    border-radius: 0.5rem;
    background: var(--background);
  }

  .secret code {
    overflow: hidden;
    color: var(--accent-text);
    font-size: 0.72rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .secret button {
    display: inline-flex;
    gap: 0.35rem;
    align-items: center;
    border: 0;
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.68rem;
  }

  .done {
    width: 100%;
    margin-top: 1rem;
  }

  .dialog .actions {
    margin-top: 1.2rem;
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
      gap: 1rem;
      align-items: start;
    }

    .page-header .primary {
      width: max-content;
    }

    .form-grid,
    .scope-grid {
      grid-template-columns: 1fr;
    }

    article {
      align-items: flex-start;
      flex-wrap: wrap;
    }

    .row-actions {
      width: 100%;
      padding-left: 2.95rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .skeleton {
      animation: none;
    }
  }
</style>
