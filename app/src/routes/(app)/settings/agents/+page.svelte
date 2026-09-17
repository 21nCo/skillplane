<script lang="ts">
  import { apiRequest, jsonBody, SkillplaneApiError } from "$lib/api/client.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    Button,
    Dialog,
    EmptyState,
    ErrorState,
    IconButton,
    Input,
    Select,
    Skeleton,
  } from "@skillplane/ui";
  import {
    CheckIcon as Check,
    CopyIcon as Copy,
    KeyIcon as Key,
    PlusIcon as Plus,
    RobotIcon as Robot,
    ShieldCheckIcon as ShieldCheck,
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
    readonly credentialAvailable: boolean;
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
  let secretOpen = $state(false);
  let actionTarget = $state<{
    agent: ServicePrincipal;
    action: "rotate" | "revoke";
  } | null>(null);

  const canManage = $derived(
    store.active?.role === "owner" || store.active?.role === "admin",
  );
  const roleOptions = [
    { value: "viewer", label: "Viewer" },
    { value: "editor", label: "Editor" },
    { value: "admin", label: "Admin" },
  ] as const;

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
    if (!workspaceId || saving) return;
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
      secretOpen = true;
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
        secretOpen = true;
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

  function acknowledgeSecret() {
    credential = null;
    credentialFor = null;
    copied = false;
    secretOpen = false;
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
      <Button variant="primary" onclick={() => (createOpen = true)}>
        {#snippet leading()}<Plus size={16} weight="bold" />{/snippet}
        New credential
      </Button>
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
        <IconButton label="Close credential form" onclick={() => (createOpen = false)}>
          <X size={16} weight="bold" />
        </IconButton>
      </div>
      <form onsubmit={createAgent}>
        <div class="form-grid">
          <div class="field">
            <Input
              label="Name"
              required
              maxlength={120}
              placeholder="PR review bot"
              bind:value={name}
              error={formError ?? undefined}
            />
          </div>
          <div class="field">
            <Select label="Workspace role" options={roleOptions} bind:value={role} />
          </div>
          <div class="field">
            <Input label="Expires on (optional)" type="date" bind:value={expiresAt} />
          </div>
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
        <div class="actions">
          <Button onclick={() => (createOpen = false)}>Cancel</Button>
          <Button
            type="submit"
            variant="primary"
            loading={saving}
            disabled={saving || scopes.length === 0}
          >
            Create credential
          </Button>
        </div>
      </form>
    </section>
  {/if}

  {#if loading}
    <section class="list-card" aria-label="Loading agent credentials" aria-busy="true">
      <Skeleton height="5.2rem" />
      <Skeleton height="5.2rem" />
      <Skeleton height="5.2rem" />
    </section>
  {:else if error}
    <ErrorState
      title="Agent credentials could not be loaded"
      description={error}
      retry={() => void load()}
    />
  {:else if agents.length === 0}
    <EmptyState
      title="No agent credentials yet"
      description="Create a scoped identity when an agent needs API or MCP access without an interactive user session."
    >
      {#snippet icon()}<Robot size={26} weight="duotone" />{/snippet}
      {#snippet action()}
        {#if canManage}
          <Button onclick={() => (createOpen = true)}>
            {#snippet leading()}<Plus size={15} weight="bold" />{/snippet}
            Create the first credential
          </Button>
        {/if}
      {/snippet}
    </EmptyState>
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
              {agent.credentialAvailable
                ? ""
                : " · credential unavailable — rotate to replace"}
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
              <Button
                size="sm"
                onclick={() => (actionTarget = { agent, action: "rotate" })}
              >
                Rotate
              </Button>
              <Button
                size="sm"
                variant="danger"
                onclick={() => (actionTarget = { agent, action: "revoke" })}
              >
                Revoke
              </Button>
            </div>
          {/if}
        </article>
      {/each}
    </section>
  {/if}
</main>

{#if credential}
  {#snippet secretBody()}
    <p class="section-label">One-time secret</p>
    <div class="secret">
      <code>{credential}</code>
      {#if copied}
        <Button size="sm" variant="ghost" onclick={() => void copyCredential()}>
          {#snippet leading()}<Check size={16} weight="bold" />{/snippet}
          Copied
        </Button>
      {:else}
        <Button size="sm" variant="ghost" onclick={() => void copyCredential()}>
          {#snippet leading()}<Copy size={16} weight="bold" />{/snippet}
          Copy
        </Button>
      {/if}
    </div>
  {/snippet}

  <Dialog
    bind:open={secretOpen}
    title="Save the credential for {credentialFor}"
    description="This secret will not be shown again. Store it in your agent’s encrypted secret manager. Only a secure hash is retained."
  >
    {@render secretBody()}
    {#snippet footer()}
      <Button variant="primary" onclick={acknowledgeSecret}>I have saved it</Button>
    {/snippet}
  </Dialog>

  {#if !secretOpen}
    <section class="create-card" role="status" aria-labelledby="credential-title">
      <h2 id="credential-title">Save the credential for {credentialFor}</h2>
      <p class="dialog-copy">
        The dialog was closed, but this secret is still shown once. Store it before
        continuing. Only a secure hash is retained.
      </p>
      {@render secretBody()}
      <div class="actions">
        <Button variant="primary" onclick={acknowledgeSecret}>I have saved it</Button>
      </div>
    </section>
  {/if}
{/if}

{#if actionTarget}
  {@const target = actionTarget}
  <Dialog
    open
    title={target.action === "rotate"
      ? "Rotate this credential?"
      : "Revoke this credential?"}
    onOpenChange={(open) => {
      if (!open) actionTarget = null;
    }}
  >
    <p class="dialog-copy">
      {#if target.action === "rotate"}
        The current secret for {target.agent.name} will stop working immediately. A replacement
        will be displayed once.
      {:else}
        {target.agent.name} will immediately lose access. Existing audit history and attribution
        will be preserved.
      {/if}
    </p>
    {#snippet footer()}
      <Button onclick={() => (actionTarget = null)}>Cancel</Button>
      <Button
        variant={target.action === "revoke" ? "danger" : "primary"}
        onclick={() => void completeAction()}
      >
        {target.action === "rotate" ? "Rotate credential" : "Revoke access"}
      </Button>
    {/snippet}
  </Dialog>
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
  .list-card {
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

  form {
    display: grid;
    gap: 1rem;
  }

  .form-grid {
    display: grid;
    grid-template-columns: minmax(12rem, 1fr) 10rem 11rem;
    gap: 0.75rem;
  }

  .field {
    min-width: 0;
  }

  legend {
    display: block;
    margin-bottom: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.7rem;
    font-weight: 620;
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

  .dialog-copy {
    color: var(--text-secondary);
    font-size: 0.76rem;
    line-height: 1.6;
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
</style>
