<script lang="ts">
  import { goto } from "$app/navigation";
  import { resolve } from "$app/paths";
  import { BrandMark } from "@skillplane/ui";
  import { page } from "$app/state";
  import { apiRequest, SkillplaneApiError } from "$lib/api/client.js";
  import { getSession } from "$lib/auth/client.js";
  import {
    ArrowRightIcon as ArrowRight,
    BuildingsIcon as Buildings,
    CheckCircleIcon as CheckCircle,
    EnvelopeOpenIcon as EnvelopeOpen,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";
  import { onMount } from "svelte";

  interface Invitation {
    readonly workspaceId: string;
    readonly workspaceName: string;
    readonly role: string;
    readonly expiresAt: string;
  }

  type State =
    | { kind: "loading" }
    | { kind: "signed-out" }
    | { kind: "ready"; invitation: Invitation }
    | { kind: "accepting"; invitation: Invitation }
    | { kind: "accepted"; workspaceName: string }
    | { kind: "error"; message: string; requestId?: string };

  let state = $state<State>({ kind: "loading" });
  const token = $derived(page.params.token ?? "");

  async function load() {
    state = { kind: "loading" };
    try {
      if (!(await getSession())) {
        state = { kind: "signed-out" };
        return;
      }
      const data = await apiRequest<{ invitation: Invitation }>(
        `/api/v1/invitations/${encodeURIComponent(token)}`,
      );
      state = { kind: "ready", invitation: data.invitation };
    } catch (error) {
      state = {
        kind: "error",
        message:
          error instanceof SkillplaneApiError
            ? error.message
            : "This invitation could not be opened.",
        ...(error instanceof SkillplaneApiError && error.requestId
          ? { requestId: error.requestId }
          : {}),
      };
    }
  }

  async function accept(invitation: Invitation) {
    state = { kind: "accepting", invitation };
    try {
      const data = await apiRequest<{
        workspace: { name: string };
      }>(`/api/v1/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
      });
      state = { kind: "accepted", workspaceName: data.workspace.name };
    } catch (error) {
      state = {
        kind: "error",
        message:
          error instanceof SkillplaneApiError
            ? error.message
            : "The invitation could not be accepted.",
        ...(error instanceof SkillplaneApiError && error.requestId
          ? { requestId: error.requestId }
          : {}),
      };
    }
  }

  function acceptCurrent() {
    if (state.kind === "ready") void accept(state.invitation);
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:head>
  <title>Workspace invitation · Skillplane</title>
</svelte:head>

<main>
  <a class="brand" href={resolve("/")} aria-label="Skillplane home">
    <BrandMark size="1.7rem" />
    Skillplane
  </a>

  <section class="card" aria-live="polite">
    {#if state.kind === "loading"}
      <span class="spinner" aria-hidden="true"></span>
      <p class="loading">Checking your invitation…</p>
    {:else if state.kind === "signed-out"}
      <div class="icon">
        <EnvelopeOpen size={24} weight="duotone" aria-hidden="true" />
      </div>
      <p class="eyebrow">Workspace invitation</p>
      <h1>Sign in to continue</h1>
      <p class="copy">
        Invitations are bound to the intended email address. Sign in with the email that
        received this link.
      </p>
      <a
        class="primary"
        href={resolve(`/sign-in?next=${encodeURIComponent(page.url.pathname)}`)}
      >
        Sign in with email <ArrowRight size={16} weight="bold" aria-hidden="true" />
      </a>
    {:else if state.kind === "ready" || state.kind === "accepting"}
      <div class="icon">
        <Buildings size={24} weight="duotone" aria-hidden="true" />
      </div>
      <p class="eyebrow">You’re invited</p>
      <h1>Join {state.invitation.workspaceName}</h1>
      <p class="copy">
        You’ll join as <strong>{state.invitation.role}</strong> and get access to this workspace’s
        shared skills and context knowledge.
      </p>
      <p class="expiry">
        Invitation expires {new Date(state.invitation.expiresAt).toLocaleString()}
      </p>
      <button
        class="primary"
        type="button"
        disabled={state.kind === "accepting"}
        onclick={acceptCurrent}
      >
        {state.kind === "accepting" ? "Joining…" : "Accept invitation"}
        <ArrowRight size={16} weight="bold" aria-hidden="true" />
      </button>
    {:else if state.kind === "accepted"}
      <div class="icon success">
        <CheckCircle size={25} weight="fill" aria-hidden="true" />
      </div>
      <p class="eyebrow">Invitation accepted</p>
      <h1>Welcome to {state.workspaceName}</h1>
      <p class="copy">
        Your membership is active. The workspace is now available in your switcher.
      </p>
      <button
        class="primary"
        type="button"
        onclick={() => void goto(resolve("/workspaces"))}
      >
        Open workspace <ArrowRight size={16} weight="bold" aria-hidden="true" />
      </button>
    {:else}
      <div class="icon error">
        <WarningCircle size={24} weight="duotone" aria-hidden="true" />
      </div>
      <p class="eyebrow">Invitation unavailable</p>
      <h1>This link can’t be used</h1>
      <p class="copy">{state.message}</p>
      {#if state.requestId}<p class="request-id">Reference {state.requestId}</p>{/if}
      <button class="secondary" type="button" onclick={() => void load()}>Retry</button>
    {/if}
  </section>
</main>

<style>
  main {
    display: grid;
    min-height: 100vh;
    padding: 1.25rem;
    place-items: center;
  }

  .brand {
    position: absolute;
    top: 1.4rem;
    left: 1.4rem;
    display: inline-flex;
    gap: 0.6rem;
    align-items: center;
    color: var(--text);
    font-size: 0.85rem;
    font-weight: 680;
    text-decoration: none;
  }

  .card {
    width: min(100%, 30rem);
    padding: clamp(1.5rem, 5vw, 2.4rem);
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    background: var(--surface);
    box-shadow: 0 2rem 6rem var(--shadow);
    text-align: center;
  }

  .icon {
    display: grid;
    width: 3rem;
    height: 3rem;
    margin: 0 auto 1rem;
    place-items: center;
    border-radius: 0.7rem;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .icon.success {
    color: var(--success);
  }

  .icon.error {
    background: var(--danger-soft);
    color: var(--danger);
  }

  .eyebrow {
    margin: 0 0 0.55rem;
    color: var(--text-tertiary);
    font-size: 0.66rem;
    font-weight: 720;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(1.45rem, 5vw, 1.9rem);
    font-weight: 640;
    letter-spacing: -0.035em;
  }

  .copy {
    margin: 0.8rem 0 0;
    color: var(--text-secondary);
    font-size: 0.8rem;
    line-height: 1.65;
  }

  .copy strong {
    color: var(--text);
    text-transform: capitalize;
  }

  .expiry,
  .request-id {
    margin: 0.8rem 0 0;
    color: var(--text-tertiary);
    font-size: 0.67rem;
  }

  .primary,
  .secondary {
    display: inline-flex;
    min-height: 2.5rem;
    gap: 0.45rem;
    align-items: center;
    justify-content: center;
    margin-top: 1.35rem;
    padding: 0 1rem;
    border-radius: 0.5rem;
    cursor: pointer;
    font-size: 0.78rem;
    font-weight: 650;
    text-decoration: none;
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

  button:disabled {
    cursor: wait;
    opacity: 0.6;
  }

  .spinner {
    display: block;
    width: 1.5rem;
    height: 1.5rem;
    margin: 0 auto;
    border: 2px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.7s linear infinite;
  }

  .loading {
    margin: 0.9rem 0 0;
    color: var(--text-secondary);
    font-size: 0.78rem;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .spinner {
      animation: none;
    }
  }
</style>
