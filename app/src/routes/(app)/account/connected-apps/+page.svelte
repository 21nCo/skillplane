<script lang="ts">
  import {
    ConnectedApps,
    type OAuthConnection,
  } from "$lib/oauth-connections/connections.svelte.js";
  import { Button, Dialog, EmptyState, ErrorState, Skeleton } from "@skillplane/ui";
  import { PlugsConnectedIcon as PlugsConnected } from "phosphor-svelte";
  import { onMount, tick } from "svelte";

  const apps = new ConnectedApps();
  let heading = $state<HTMLHeadingElement>();
  let list = $state<HTMLUListElement>();
  let target = $state<OAuthConnection | null>(null);
  let confirmOpen = $state(false);

  const timeFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });

  function formatTime(value: string): string {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? value : timeFormat.format(parsed);
  }

  function revokeButton(consentId: string | undefined): HTMLButtonElement | null {
    if (!consentId) return null;
    return (
      list?.querySelector<HTMLButtonElement>(
        `button[data-consent-id="${CSS.escape(consentId)}"]`,
      ) ?? null
    );
  }

  function requestRevoke(connection: OAuthConnection) {
    target = connection;
    confirmOpen = true;
  }

  async function confirmRevoke() {
    const connection = target;
    confirmOpen = false;
    if (!connection) return;
    const index = apps.visible.findIndex(
      (candidate) => candidate.consentId === connection.consentId,
    );
    if (index === -1) return;
    const neighbour =
      apps.visible.at(index + 1) ??
      (index > 0 ? apps.visible.at(index - 1) : undefined);
    // The row leaves the list synchronously; move focus to the next row's
    // revoke button, or to the page heading when no row is left.
    const pending = apps.revoke(connection.consentId);
    await tick();
    const moved = revokeButton(neighbour?.consentId) ?? heading ?? null;
    moved?.focus();
    if ((await pending) !== "failed") return;
    await tick();
    // The row is back. Return focus to it unless the user has moved on.
    const active = document.activeElement;
    if (active === moved || active === document.body || active === null) {
      revokeButton(connection.consentId)?.focus();
    }
  }

  onMount(() => {
    void apps.load();
  });
</script>

<svelte:head>
  <title>Connected apps · Skillplane</title>
</svelte:head>

<main class="page">
  <header class="page-header">
    <p class="eyebrow">Account</p>
    <h1 bind:this={heading} tabindex="-1">Connected apps</h1>
    <p>
      MCP clients you allowed to use Skillplane with your account. Revoking one ends its
      access immediately, and it must ask for your approval again to reconnect.
    </p>
  </header>

  <p class="sr-only" role="status">{apps.announcement}</p>

  {#if apps.revokeError}
    <p class="revoke-error" role="alert">{apps.revokeError}</p>
  {/if}

  {#if apps.status === "loading"}
    <section class="list-card" aria-label="Loading connected apps" aria-busy="true">
      <Skeleton height="6rem" />
      <Skeleton height="6rem" />
    </section>
  {:else if apps.status === "error"}
    <ErrorState
      title="Connected apps could not be loaded"
      description={apps.loadError ?? "Connected apps could not be loaded."}
      retry={() => void apps.load()}
    />
  {:else if apps.visible.length === 0}
    <EmptyState
      title="No connected apps"
      description="When you allow an MCP client to use Skillplane, it appears here and you can revoke its access."
    >
      {#snippet icon()}<PlugsConnected size={26} weight="duotone" />{/snippet}
    </EmptyState>
  {:else}
    <section class="list-card" aria-labelledby="connections-heading">
      <div class="list-heading">
        <h2 id="connections-heading">Authorized clients</h2>
        <p>
          {apps.visible.length}
          {apps.visible.length === 1 ? "client has" : "clients have"} access
        </p>
      </div>
      <ul class="connections" bind:this={list}>
        {#each apps.visible as connection (connection.consentId)}
          {@const titleId = `connection-${connection.consentId}`}
          {@const resourceId = `${titleId}-resource`}
          <li>
            <div class="client-icon" aria-hidden="true">
              {Array.from(connection.clientName)[0]?.toLocaleUpperCase() ?? ""}
            </div>
            <div class="details">
              <h3 id={titleId}>{connection.clientName}</h3>
              {#if connection.clientName !== connection.clientId}
                <p class="client-id">{connection.clientId}</p>
              {/if}
              <dl>
                <div>
                  <dt>Resource</dt>
                  <dd><code id={resourceId}>{connection.resource}</code></dd>
                </div>
                <div>
                  <dt>Permissions</dt>
                  <dd>
                    {#if connection.scopes.length === 0}
                      None
                    {:else}
                      <ul class="scopes">
                        {#each connection.scopes as scope (scope)}
                          <li><code>{scope}</code></li>
                        {/each}
                      </ul>
                    {/if}
                  </dd>
                </div>
                <div>
                  <dt>Authorized</dt>
                  <dd>
                    <time datetime={connection.grantedAt}>
                      {formatTime(connection.grantedAt)}
                    </time>
                  </dd>
                </div>
                <div>
                  <dt>Last token issued</dt>
                  <dd>
                    {#if connection.lastTokenIssuedAt}
                      <time datetime={connection.lastTokenIssuedAt}>
                        {formatTime(connection.lastTokenIssuedAt)}
                      </time>
                    {:else}
                      Not recorded
                    {/if}
                  </dd>
                </div>
              </dl>
            </div>
            <div class="row-action">
              <Button
                size="sm"
                variant="danger"
                data-consent-id={connection.consentId}
                aria-label={`Revoke ${connection.clientName}`}
                aria-describedby={resourceId}
                onclick={() => requestRevoke(connection)}
              >
                Revoke
              </Button>
            </div>
          </li>
        {/each}
      </ul>
    </section>
    <p class="footnote">
      Last token issued is when the client last exchanged an authorization code or
      refreshed its token. Skillplane does not record each MCP request.
    </p>
  {/if}
</main>

<Dialog
  bind:open={confirmOpen}
  title={target ? `Revoke ${target.clientName}?` : "Revoke access?"}
  description="It loses access to Skillplane immediately. Its access and refresh tokens stop working, and it must ask for your approval again to reconnect."
>
  {#if target}
    <p class="dialog-copy">
      Resource <code>{target.resource}</code>
    </p>
  {/if}
  {#snippet footer()}
    <Button data-autofocus onclick={() => (confirmOpen = false)}>Cancel</Button>
    <Button variant="danger" onclick={() => void confirmRevoke()}>Revoke access</Button>
  {/snippet}
</Dialog>

<style>
  .page {
    width: min(100% - 2.5rem, 56rem);
    margin: 0 auto;
    padding: 3.25rem 0 5rem;
  }

  .page-header {
    margin-bottom: var(--sp-space-5);
  }

  .eyebrow {
    margin: 0 0 var(--sp-space-2);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.075em;
    text-transform: uppercase;
  }

  h1,
  h2,
  h3,
  p,
  dl,
  dd {
    margin: 0;
  }

  h1 {
    font-size: clamp(1.65rem, 4vw, 2.15rem);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: -0.035em;
  }

  h1:focus {
    outline: none;
  }

  h1:focus-visible {
    outline: 2px solid var(--sp-color-focus);
    outline-offset: 4px;
  }

  .page-header p:last-child {
    max-width: 42rem;
    margin-top: var(--sp-space-2);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: 1.55;
  }

  .revoke-error {
    margin-bottom: var(--sp-space-4);
    padding: var(--sp-space-3) var(--sp-space-4);
    border: 1px solid color-mix(in srgb, var(--sp-color-danger) 40%, transparent);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-danger-soft);
    color: var(--sp-color-text);
    font-size: var(--sp-font-size-2);
    line-height: 1.5;
  }

  .list-card {
    display: grid;
    gap: var(--sp-space-2);
    overflow: hidden;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface);
  }

  .list-card[aria-busy="true"] {
    padding: var(--sp-space-4);
  }

  .list-heading {
    display: flex;
    gap: var(--sp-space-3);
    align-items: baseline;
    justify-content: space-between;
    padding: var(--sp-space-4);
    border-bottom: 1px solid var(--sp-color-border);
  }

  h2 {
    font-size: var(--sp-font-size-4);
  }

  .list-heading p {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .connections > li {
    display: flex;
    gap: var(--sp-space-3);
    align-items: flex-start;
    padding: var(--sp-space-4);
  }

  .connections > li + li {
    border-top: 1px solid var(--sp-color-border);
  }

  .client-icon {
    display: grid;
    width: 2.2rem;
    height: 2.2rem;
    flex: 0 0 auto;
    place-items: center;
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    font-weight: var(--sp-weight-bold);
  }

  .details {
    min-width: 0;
    flex: 1;
  }

  h3 {
    overflow-wrap: anywhere;
    font-size: var(--sp-font-size-3);
  }

  .client-id {
    margin-top: var(--sp-space-1);
    overflow-wrap: anywhere;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--sp-space-3) var(--sp-space-4);
    margin-top: var(--sp-space-3);
  }

  dl > div {
    min-width: 0;
  }

  dt {
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
  }

  dd {
    margin-top: var(--sp-space-1);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  code {
    overflow-wrap: anywhere;
    font-family: var(--sp-font-mono);
    font-size: var(--sp-font-size-1);
  }

  .scopes {
    display: flex;
    flex-wrap: wrap;
    gap: var(--sp-space-1);
  }

  .scopes li {
    padding: 0.1rem var(--sp-space-2);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-round);
  }

  .row-action {
    flex: 0 0 auto;
  }

  .footnote {
    margin-top: var(--sp-space-3);
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    line-height: 1.5;
  }

  .dialog-copy {
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    overflow-wrap: anywhere;
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  @media (max-width: 47.999rem) {
    .page {
      width: min(100% - 1.5rem, 56rem);
      padding-top: var(--sp-space-6);
    }

    .connections > li {
      flex-wrap: wrap;
    }

    dl {
      grid-template-columns: minmax(0, 1fr);
    }

    .row-action {
      width: 100%;
      padding-left: 2.95rem;
    }
  }
</style>
