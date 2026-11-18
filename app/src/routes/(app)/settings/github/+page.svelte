<script lang="ts">
  import { page } from "$app/state";
  import { replaceState } from "$app/navigation";
  import { resolve } from "$app/paths";
  import {
    githubInstallHref,
    githubSetupErrorMessage,
    listGitHubInstallations,
    listGitHubRepositories,
    unbindGitHubInstallation,
    type GitHubInstallation,
    type GitHubRepository,
  } from "$lib/github/api.js";
  import { useWorkspaceStore } from "$lib/workspaces/store.svelte.js";
  import {
    Badge,
    Button,
    Dialog,
    EmptyState,
    ErrorState,
    Skeleton,
  } from "@skillplane/ui";
  import { GithubLogoIcon as GithubLogo } from "phosphor-svelte";

  const store = useWorkspaceStore();
  let installations = $state<GitHubInstallation[]>([]);
  let installable = $state(false);
  let repositories = $state<Record<number, GitHubRepository[] | string>>({});
  let loading = $state(true);
  let error = $state<string | null>(null);
  let notice = $state<string | null>(null);
  let actionError = $state<string | null>(null);
  let unbindTarget = $state<GitHubInstallation | null>(null);
  let unbinding = $state(false);

  const canManage = $derived(
    store.active?.role === "owner" || store.active?.role === "admin",
  );

  // The install callback returns here with the outcome in the query string.
  $effect(() => {
    const connected = page.url.searchParams.get("github_connected");
    const failed = page.url.searchParams.get("github_error");
    if (!connected && !failed) return;
    if (connected) notice = "GitHub installation connected.";
    if (failed) actionError = githubSetupErrorMessage(failed);
    replaceState(resolve("/settings/github"), page.state);
  });

  $effect(() => {
    if (store.activeId) void load();
  });

  async function load() {
    const workspaceId = store.activeId;
    if (!workspaceId) return;
    loading = true;
    error = null;
    try {
      const data = await listGitHubInstallations(workspaceId);
      if (workspaceId !== store.activeId) return;
      installations = data.installations;
      installable = data.installable;
      repositories = {};
      for (const installation of data.installations)
        if (installation.status === "active")
          void loadRepositories(workspaceId, installation.installationId);
    } catch (caught) {
      error =
        caught instanceof Error
          ? caught.message
          : "GitHub installations could not be loaded.";
    } finally {
      loading = false;
    }
  }

  async function loadRepositories(workspaceId: string, installationId: number) {
    try {
      const data = await listGitHubRepositories(workspaceId, installationId);
      if (workspaceId === store.activeId)
        repositories = { ...repositories, [installationId]: data.repositories };
    } catch (caught) {
      if (workspaceId === store.activeId)
        repositories = {
          ...repositories,
          [installationId]:
            caught instanceof Error
              ? caught.message
              : "Repositories could not be loaded.",
        };
    }
  }

  async function unbind() {
    const workspaceId = store.activeId;
    const target = unbindTarget;
    if (!workspaceId || !target || unbinding) return;
    unbinding = true;
    actionError = null;
    try {
      const result = await unbindGitHubInstallation(workspaceId, target.installationId);
      notice =
        result.sourcesMarked > 0
          ? `${target.accountLogin} was disconnected. ${String(result.sourcesMarked)} source${result.sourcesMarked === 1 ? "" : "s"} now need reconnecting.`
          : `${target.accountLogin} was disconnected.`;
      unbindTarget = null;
      await load();
    } catch (caught) {
      actionError =
        caught instanceof Error
          ? caught.message
          : "The installation could not be disconnected.";
      unbindTarget = null;
    } finally {
      unbinding = false;
    }
  }

  function statusLabel(installation: GitHubInstallation) {
    if (installation.status === "removed") return "Uninstalled on GitHub";
    if (installation.status === "suspended") return "Suspended on GitHub";
    return "Active";
  }
</script>

<svelte:head>
  <title>GitHub · Skillplane</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <div>
      <p class="eyebrow">Workspace settings</p>
      <h1>GitHub</h1>
      <p>
        Connect the Skillplane GitHub App so Git sources in {store.active?.name} can read
        private repositories.
      </p>
    </div>
    {#if canManage && installable && store.activeId}
      <Button variant="primary" href={githubInstallHref(store.activeId)}>
        {#snippet leading()}<GithubLogo size={16} weight="bold" />{/snippet}
        Connect GitHub
      </Button>
    {/if}
  </header>

  {#if notice}<p class="notice" role="status">{notice}</p>{/if}
  {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}

  {#if loading}
    <section class="panel" aria-label="Loading GitHub installations" aria-busy="true">
      <Skeleton height="3.8rem" />
      <Skeleton height="3.8rem" />
    </section>
  {:else if error}
    <ErrorState
      title="GitHub installations could not be loaded"
      description={error}
      retry={() => void load()}
    />
  {:else}
    <section class="panel" aria-labelledby="installations-title">
      <div class="panel-heading">
        <div>
          <h2 id="installations-title">Connected installations</h2>
          <p>
            {canManage
              ? "Each installation can be connected to one workspace."
              : "Only workspace owners and admins can connect or disconnect GitHub."}
          </p>
        </div>
      </div>
      {#if installations.length === 0}
        <div class="empty-wrap">
          <EmptyState
            compact
            title="No GitHub installations"
            description={installable
              ? "Connect GitHub to choose the repositories Skillplane may read."
              : "The GitHub App is not configured for this deployment."}
          >
            {#snippet icon()}<GithubLogo size={24} weight="duotone" />{/snippet}
          </EmptyState>
        </div>
      {:else}
        <ul class="rows">
          {#each installations as installation (installation.installationId)}
            {@const repos = repositories[installation.installationId]}
            <li class="installation-row">
              <div class="identity">
                <strong>{installation.accountLogin}</strong>
                <span>
                  {installation.accountType} ·
                  {installation.repositorySelection === "all"
                    ? "All repositories"
                    : "Selected repositories"}
                </span>
                {#if installation.status !== "active"}
                  <span>
                    Sources reading through it report auth_failed until it is active
                    again.
                  </span>
                {:else if typeof repos === "string"}
                  <span role="alert">{repos}</span>
                {:else if repos}
                  <ul
                    class="repositories"
                    aria-label={`Repositories of ${installation.accountLogin}`}
                  >
                    {#each repos as repository (repository.fullName)}
                      <li>
                        {repository.fullName}{repository.private ? " · private" : ""}
                      </li>
                    {:else}
                      <li>No repositories selected</li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <Badge tone={installation.status === "active" ? "success" : "warning"}
                >{statusLabel(installation)}</Badge
              >
              {#if canManage}
                <Button
                  size="sm"
                  variant="danger"
                  aria-label={`Disconnect ${installation.accountLogin}`}
                  onclick={() => (unbindTarget = installation)}>Disconnect</Button
                >
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</main>

{#if unbindTarget}
  <Dialog
    open
    title="Disconnect this installation?"
    description={`Sources reading ${unbindTarget.accountLogin} repositories are kept with their skills and history, and report auth_failed until the installation is connected again. The App stays installed on GitHub.`}
    onOpenChange={(open) => {
      if (!open) unbindTarget = null;
    }}
  >
    {#snippet footer()}
      <Button onclick={() => (unbindTarget = null)}>Cancel</Button>
      <Button
        variant="danger"
        loading={unbinding}
        disabled={unbinding}
        onclick={() => void unbind()}>Disconnect installation</Button
      >
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
  .panel-heading,
  .installation-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .page-header,
  .panel-heading {
    justify-content: space-between;
  }

  .page-header {
    align-items: flex-end;
    margin-bottom: 1.5rem;
  }

  .eyebrow {
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
    font-size: 0.9rem;
  }

  .page-header p:last-child,
  .panel-heading p,
  .identity span,
  .repositories {
    margin-top: 0.35rem;
    color: var(--text-secondary);
    font-size: 0.75rem;
  }

  .notice,
  .form-error {
    margin-bottom: 1rem;
    padding: 0.75rem 0.9rem;
    border-radius: 0.55rem;
    font-size: 0.77rem;
  }

  .notice {
    border: 1px solid color-mix(in srgb, var(--success) 35%, var(--border));
    background: color-mix(in srgb, var(--success) 8%, var(--surface));
    color: var(--success);
  }

  .form-error {
    border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
    background: color-mix(in srgb, var(--danger) 8%, var(--surface));
    color: var(--danger);
  }

  .panel {
    border: 1px solid var(--border);
    border-radius: 0.7rem;
    background: var(--surface);
  }

  .panel-heading {
    padding: 1rem;
    border-bottom: 1px solid var(--border);
  }

  .rows,
  .repositories {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .installation-row {
    padding: 0.9rem 1rem;
    border-bottom: 1px solid var(--border);
  }

  .installation-row:last-child {
    border-bottom: 0;
  }

  .identity {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .empty-wrap {
    padding: 1rem;
  }
</style>
