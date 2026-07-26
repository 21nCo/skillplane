<script lang="ts">
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import {
    ArrowSquareOutIcon as ArrowSquareOut,
    CheckCircleIcon as CheckCircle,
    GlobeHemisphereWestIcon as Globe,
    LockKeyIcon as LockKey,
    MoonIcon as Moon,
    ShieldCheckIcon as ShieldCheck,
    SunIcon as Sun,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";
  import { onMount } from "svelte";

  interface ConsentDetails {
    readonly client: { readonly id: string; readonly name: string };
    readonly resource: string;
    readonly scopes: readonly string[];
    readonly redirect: {
      readonly uri: string;
      readonly host: string;
      readonly loopback: boolean;
    };
  }

  type ConsentState =
    | { kind: "loading" }
    | { kind: "ready"; details: ConsentDetails }
    | { kind: "submitting"; details: ConsentDetails; decision: "approve" | "deny" }
    | { kind: "error"; message: string };

  const scopeCopy: Readonly<Record<string, string>> = {
    "skills:read": "Read the skills and published versions you can access",
    "skills:amend": "Propose improvements and new versions of skills",
    "contexts:read": "Read context knowledge and agent notes",
    "contexts:write": "Create or update context knowledge and notes",
    "audit:read": "Read audit history for resources you can access",
  };

  let consentState = $state<ConsentState>({ kind: "loading" });
  let theme = $state<"dark" | "light">("dark");
  const requestToken = $derived(page.url.searchParams.get("request") ?? "");

  function applyTheme(nextTheme: "dark" | "light") {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("skillplane.theme", nextTheme);
  }

  function csrfToken(): string | undefined {
    const value = document.cookie
      .split(";")
      .map((entry) => entry.trim())
      .find((entry) => entry.startsWith("skillplane.csrf="))
      ?.slice("skillplane.csrf=".length);
    return value ? decodeURIComponent(value) : undefined;
  }

  async function errorMessage(response: Response): Promise<string> {
    try {
      const body = (await response.json()) as {
        readonly error_description?: unknown;
      };
      return typeof body.error_description === "string"
        ? body.error_description
        : "This authorization request could not be completed.";
    } catch {
      return "This authorization request could not be completed.";
    }
  }

  async function loadConsent() {
    if (!requestToken) {
      consentState = {
        kind: "error",
        message: "The authorization request is missing.",
      };
      return;
    }
    consentState = { kind: "loading" };
    try {
      const response = await fetch(
        `/auth/oauth/consent?request=${encodeURIComponent(requestToken)}`,
        {
          credentials: "include",
          headers: { accept: "application/json" },
        },
      );
      if (!response.ok) {
        consentState = { kind: "error", message: await errorMessage(response) };
        return;
      }
      consentState = {
        kind: "ready",
        details: (await response.json()) as ConsentDetails,
      };
    } catch {
      consentState = {
        kind: "error",
        message: "Skillplane could not be reached. Check your connection and retry.",
      };
    }
  }

  async function decide(approved: boolean) {
    if (consentState.kind !== "ready") return;
    const details = consentState.details;
    consentState = {
      kind: "submitting",
      details,
      decision: approved ? "approve" : "deny",
    };
    try {
      const csrf = csrfToken();
      const response = await fetch("/auth/oauth/consent", {
        method: "POST",
        credentials: "include",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          ...(csrf ? { "x-authfn-csrf": csrf } : {}),
        },
        body: JSON.stringify({ request: requestToken, approved }),
      });
      if (!response.ok) {
        consentState = {
          kind: "error",
          message: await errorMessage(response),
        };
        return;
      }
      const body = (await response.json()) as { readonly redirectTo?: unknown };
      if (typeof body.redirectTo !== "string") {
        consentState = {
          kind: "error",
          message: "The authorization server returned an invalid redirect.",
        };
        return;
      }
      window.location.assign(body.redirectTo);
    } catch {
      consentState = {
        kind: "error",
        message: "The consent decision could not be saved. Please retry.",
      };
    }
  }

  onMount(() => {
    applyTheme(localStorage.getItem("skillplane.theme") === "light" ? "light" : "dark");
    void loadConsent();
  });
</script>

<svelte:head>
  <title>Authorize agent · Skillplane</title>
  <meta
    name="description"
    content="Review and approve access to Skillplane skills through MCP."
  />
</svelte:head>

<main>
  <header>
    <a class="brand" href={resolve("/")} aria-label="Skillplane home">
      <span aria-hidden="true">S</span>
      Skillplane
    </a>
    <button
      class="theme-toggle"
      type="button"
      aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
      onclick={() => applyTheme(theme === "dark" ? "light" : "dark")}
    >
      {#if theme === "dark"}
        <Sun size={16} weight="bold" aria-hidden="true" />
      {:else}
        <Moon size={16} weight="bold" aria-hidden="true" />
      {/if}
    </button>
  </header>

  <section class="consent-card" aria-live="polite">
    {#if consentState.kind === "loading"}
      <span class="spinner" aria-hidden="true"></span>
      <h1>Loading authorization request</h1>
      <p class="lede">Checking the client, resource, and requested permissions…</p>
    {:else if consentState.kind === "error"}
      <div class="hero-icon error">
        <WarningCircle size={24} weight="duotone" aria-hidden="true" />
      </div>
      <p class="eyebrow">Authorization unavailable</p>
      <h1>This request can’t be completed</h1>
      <p class="lede">{consentState.message}</p>
      <div class="error-actions">
        <button class="secondary" type="button" onclick={() => void loadConsent()}>
          Try again
        </button>
        <a class="text-link" href={resolve("/")}>Return to Skillplane</a>
      </div>
    {:else}
      <div class="hero-icon">
        <ShieldCheck size={25} weight="duotone" aria-hidden="true" />
      </div>
      <p class="eyebrow">MCP authorization</p>
      <h1>Allow {consentState.details.client.name} to use Skillplane?</h1>
      <p class="lede">
        This client is asking to act with your Skillplane account. Review each
        permission before continuing.
      </p>

      <div class="client-row">
        <div class="client-avatar" aria-hidden="true">
          {consentState.details.client.name.slice(0, 1).toUpperCase()}
        </div>
        <div>
          <strong>{consentState.details.client.name}</strong>
          <span title={consentState.details.client.id}>
            {consentState.details.client.id}
          </span>
        </div>
      </div>

      <div class="permission-panel">
        <div class="panel-heading">
          <LockKey size={16} weight="duotone" aria-hidden="true" />
          <strong>Requested permissions</strong>
        </div>
        <ul>
          {#each consentState.details.scopes as scope (scope)}
            <li>
              <CheckCircle size={17} weight="fill" aria-hidden="true" />
              <div>
                <strong>{scope}</strong>
                <span>{scopeCopy[scope] ?? "Use this Skillplane permission"}</span>
              </div>
            </li>
          {/each}
        </ul>
      </div>

      <div class="connection-details">
        <div>
          <Globe size={16} weight="duotone" aria-hidden="true" />
          <span>Resource</span>
          <code>{consentState.details.resource}</code>
        </div>
        <div>
          <ArrowSquareOut size={16} weight="duotone" aria-hidden="true" />
          <span>Return to</span>
          <code>{consentState.details.redirect.host}</code>
        </div>
      </div>

      {#if consentState.details.redirect.loopback}
        <div class="loopback-warning" role="note">
          <WarningCircle size={18} weight="fill" aria-hidden="true" />
          <p>
            This client will return to <strong>
              {consentState.details.redirect.host}
            </strong>
            on this device. Continue only if you started a local agent connection.
          </p>
        </div>
      {/if}

      <div class="actions">
        <button
          class="secondary"
          type="button"
          disabled={consentState.kind === "submitting"}
          onclick={() => void decide(false)}
        >
          {consentState.kind === "submitting" && consentState.decision === "deny"
            ? "Denying…"
            : "Deny"}
        </button>
        <button
          class="primary"
          type="button"
          disabled={consentState.kind === "submitting"}
          onclick={() => void decide(true)}
        >
          {consentState.kind === "submitting" && consentState.decision === "approve"
            ? "Allowing…"
            : "Allow access"}
        </button>
      </div>

      <p class="footnote">
        Skillplane never shares your session or email OTP. You can revoke this
        connection at any time.
      </p>
    {/if}
  </section>
</main>

<style>
  main {
    display: grid;
    min-height: 100vh;
    padding: 5.5rem 1.25rem 2.5rem;
    place-items: start center;
    background:
      radial-gradient(
        circle at 50% -15%,
        var(--sp-color-accent-soft),
        transparent 31rem
      ),
      var(--sp-color-canvas);
  }

  header {
    position: absolute;
    top: 0;
    left: 0;
    display: flex;
    width: 100%;
    height: 4.5rem;
    padding: 0 1.5rem;
    align-items: center;
    justify-content: space-between;
  }

  .brand {
    display: inline-flex;
    gap: 0.6rem;
    align-items: center;
    color: var(--sp-color-text);
    font-size: 0.84rem;
    font-weight: var(--sp-weight-semibold);
    text-decoration: none;
  }

  .brand span,
  .client-avatar {
    display: grid;
    place-items: center;
    border: 1px solid var(--sp-color-accent);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    font-weight: var(--sp-weight-bold);
  }

  .brand span {
    width: 1.8rem;
    height: 1.8rem;
    font-size: 0.72rem;
  }

  .theme-toggle {
    display: grid;
    width: 2rem;
    height: 2rem;
    padding: 0;
    place-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-surface);
    color: var(--sp-color-text-muted);
    cursor: pointer;
  }

  .consent-card {
    width: min(100%, 35rem);
    padding: clamp(1.5rem, 4vw, 2.25rem);
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-xl);
    background: var(--sp-color-surface);
    box-shadow: var(--sp-shadow-lg);
  }

  .hero-icon {
    display: grid;
    width: 3rem;
    height: 3rem;
    margin-bottom: 1.15rem;
    place-items: center;
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
  }

  .hero-icon.error {
    background: var(--sp-color-danger-soft);
    color: var(--sp-color-danger);
  }

  .eyebrow {
    margin: 0 0 0.45rem;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-1);
    font-weight: var(--sp-weight-bold);
    letter-spacing: 0.085em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.45rem, 5vw, 1.85rem);
    font-weight: var(--sp-weight-semibold);
    letter-spacing: -0.035em;
    line-height: 1.2;
  }

  .lede {
    margin: 0.75rem 0 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-3);
    line-height: 1.6;
  }

  .client-row {
    display: flex;
    gap: 0.75rem;
    margin-top: 1.5rem;
    padding: 0.9rem;
    align-items: center;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    background: var(--sp-color-surface-raised);
  }

  .client-avatar {
    width: 2.3rem;
    height: 2.3rem;
    flex: 0 0 auto;
    font-size: var(--sp-font-size-3);
  }

  .client-row div:last-child {
    min-width: 0;
  }

  .client-row strong,
  .client-row span {
    display: block;
  }

  .client-row strong {
    font-size: var(--sp-font-size-3);
  }

  .client-row span {
    overflow: hidden;
    margin-top: 0.2rem;
    color: var(--sp-color-text-subtle);
    font-family: var(--sp-font-mono);
    font-size: 0.64rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .permission-panel {
    margin-top: 0.85rem;
    border: 1px solid var(--sp-color-border);
    border-radius: var(--sp-radius-lg);
    overflow: hidden;
  }

  .panel-heading {
    display: flex;
    gap: 0.55rem;
    padding: 0.75rem 0.9rem;
    align-items: center;
    border-bottom: 1px solid var(--sp-color-border);
    background: var(--sp-color-surface-muted);
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
  }

  ul {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    display: flex;
    gap: 0.65rem;
    padding: 0.72rem 0.9rem;
    align-items: flex-start;
  }

  li + li {
    border-top: 1px solid var(--sp-color-border);
  }

  li > :global(svg) {
    flex: 0 0 auto;
    margin-top: 0.08rem;
    color: var(--sp-color-success);
  }

  li strong,
  li span {
    display: block;
  }

  li strong {
    font-family: var(--sp-font-mono);
    font-size: 0.68rem;
    font-weight: var(--sp-weight-semibold);
  }

  li span {
    margin-top: 0.16rem;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    line-height: 1.45;
  }

  .connection-details {
    display: grid;
    gap: 0.55rem;
    margin-top: 0.9rem;
  }

  .connection-details div {
    display: grid;
    grid-template-columns: 1rem 4.2rem minmax(0, 1fr);
    gap: 0.5rem;
    align-items: center;
    color: var(--sp-color-text-subtle);
    font-size: var(--sp-font-size-2);
  }

  code {
    overflow: hidden;
    color: var(--sp-color-text-muted);
    font-family: var(--sp-font-mono);
    font-size: 0.66rem;
    text-align: right;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .loopback-warning {
    display: flex;
    gap: 0.65rem;
    margin-top: 1rem;
    padding: 0.75rem;
    border: 1px solid color-mix(in srgb, var(--sp-color-warning) 45%, transparent);
    border-radius: var(--sp-radius-md);
    background: var(--sp-color-warning-soft);
    color: var(--sp-color-warning);
  }

  .loopback-warning > :global(svg) {
    flex: 0 0 auto;
  }

  .loopback-warning p {
    margin: 0;
    color: var(--sp-color-text-muted);
    font-size: var(--sp-font-size-2);
    line-height: 1.5;
  }

  .loopback-warning strong {
    color: var(--sp-color-warning);
  }

  .actions,
  .error-actions {
    display: flex;
    gap: 0.65rem;
    margin-top: 1.35rem;
  }

  .actions button {
    flex: 1;
  }

  button,
  .text-link {
    min-height: 2.4rem;
    border-radius: var(--sp-radius-md);
    font-size: var(--sp-font-size-3);
    font-weight: var(--sp-weight-semibold);
  }

  button {
    padding: 0 1rem;
    cursor: pointer;
  }

  button:disabled {
    cursor: wait;
    opacity: 0.65;
  }

  .primary {
    border: 1px solid var(--sp-color-accent);
    background: var(--sp-color-accent);
    color: var(--sp-color-surface);
  }

  .primary:hover:not(:disabled) {
    background: var(--sp-color-accent-hover);
  }

  .secondary {
    border: 1px solid var(--sp-color-border-strong);
    background: var(--sp-color-surface-raised);
    color: var(--sp-color-text);
  }

  .secondary:hover:not(:disabled) {
    background: var(--sp-color-surface-hover);
  }

  .text-link {
    display: inline-flex;
    padding: 0 0.6rem;
    align-items: center;
    color: var(--sp-color-text-muted);
    text-decoration: none;
  }

  .footnote {
    margin: 0.85rem 0 0;
    color: var(--sp-color-text-subtle);
    font-size: 0.66rem;
    line-height: 1.5;
    text-align: center;
  }

  .spinner {
    display: block;
    width: 1.6rem;
    height: 1.6rem;
    margin-bottom: 1.2rem;
    border: 2px solid var(--sp-color-border-strong);
    border-top-color: var(--sp-color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (max-width: 34rem) {
    main {
      padding: 4.7rem 0 0;
      place-items: stretch;
    }

    header {
      height: 4.2rem;
      padding: 0 1rem;
    }

    .consent-card {
      min-height: calc(100vh - 4.7rem);
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: var(--sp-radius-xl) var(--sp-radius-xl) 0 0;
    }

    .connection-details div {
      grid-template-columns: 1rem 3.7rem minmax(0, 1fr);
    }
  }
</style>
