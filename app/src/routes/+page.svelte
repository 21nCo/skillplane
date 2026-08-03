<script lang="ts">
  import { resolve } from "$app/paths";
  import { BrandMark } from "@skillplane/ui";
  import { onMount } from "svelte";

  interface CheckState {
    ok: boolean;
    code: string;
    latencyMs: number;
  }

  interface ReadyResponse {
    ok: boolean;
    status: "ready" | "not-ready";
    requestId: string;
    checks: {
      configuration: CheckState;
      postgres: CheckState;
      objectStorage: CheckState;
    };
  }

  type RuntimeState =
    | { kind: "loading" }
    | { kind: "ready"; response: ReadyResponse }
    | { kind: "error"; message: string; requestId?: string };

  let runtime = $state<RuntimeState>({ kind: "loading" });

  async function checkRuntime() {
    runtime = { kind: "loading" };
    try {
      const response = await fetch("/api/v1/health/ready", {
        headers: { accept: "application/json" },
      });
      const body = (await response.json()) as ReadyResponse;
      if (!response.ok || !body.ok) {
        runtime = {
          kind: "error",
          message: "The local database or object store is not ready yet.",
          requestId: body.requestId,
        };
        return;
      }
      runtime = { kind: "ready", response: body };
    } catch {
      runtime = {
        kind: "error",
        message: "The Skillplane API could not be reached.",
      };
    }
  }

  onMount(() => {
    void checkRuntime();
  });
</script>

<svelte:head>
  <title>Runtime · Skillplane</title>
</svelte:head>

<main>
  <header>
    <a class="brand" href={resolve("/")} aria-label="Skillplane home">
      <BrandMark />
      <span>Skillplane</span>
    </a>
    <span class="phase">Runtime foundation</span>
  </header>

  <section class="hero" aria-labelledby="page-title">
    <p class="eyebrow">Skills infrastructure for AI agents</p>
    <h1 id="page-title">
      A reliable control plane starts with observable foundations.
    </h1>
    <p class="lede">
      Skillplane will keep reusable skills, their version history, and project-specific
      knowledge under one auditable authority. This surface reports the actual local
      service state while the product is being assembled.
    </p>
  </section>

  <section class="runtime-card" aria-labelledby="runtime-title" aria-live="polite">
    <div class="card-heading">
      <div>
        <p class="label">Environment</p>
        <h2 id="runtime-title">Local runtime</h2>
      </div>
      {#if runtime.kind === "ready"}
        <span class="status ready"><span aria-hidden="true"></span>Ready</span>
      {:else if runtime.kind === "error"}
        <span class="status error"><span aria-hidden="true"></span>Needs attention</span
        >
      {:else}
        <span class="status loading"><span aria-hidden="true"></span>Checking</span>
      {/if}
    </div>

    {#if runtime.kind === "loading"}
      <div
        class="loading-rows"
        role="status"
        aria-label="Checking runtime dependencies"
      >
        <span></span>
        <span></span>
        <span></span>
      </div>
    {:else if runtime.kind === "ready"}
      <dl>
        <div>
          <dt>Configuration</dt>
          <dd>{runtime.response.checks.configuration.code}</dd>
        </div>
        <div>
          <dt>Postgres</dt>
          <dd>
            {runtime.response.checks.postgres.code}
            <small>{runtime.response.checks.postgres.latencyMs} ms</small>
          </dd>
        </div>
        <div>
          <dt>R2 object storage</dt>
          <dd>
            {runtime.response.checks.objectStorage.code}
            <small>{runtime.response.checks.objectStorage.latencyMs} ms</small>
          </dd>
        </div>
      </dl>
      <p class="request-id">Request {runtime.response.requestId}</p>
    {:else}
      <div class="failure">
        <p>{runtime.message}</p>
        {#if runtime.requestId}
          <p class="request-id">Request {runtime.requestId}</p>
        {/if}
        <button type="button" onclick={() => void checkRuntime()}>Retry checks</button>
      </div>
    {/if}
  </section>
</main>

<style>
  main {
    width: min(100% - 2rem, 70rem);
    margin: 0 auto;
    padding-bottom: 5rem;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 4.5rem;
    border-bottom: 1px solid var(--sp-color-border);
  }

  .brand {
    display: inline-flex;
    gap: 0.65rem;
    align-items: center;
    color: var(--sp-color-text);
    font-size: 0.9rem;
    font-weight: 650;
    text-decoration: none;
  }

  .phase,
  .label,
  .eyebrow {
    color: var(--sp-color-text-subtle);
    font-size: 0.72rem;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .hero {
    max-width: 54rem;
    padding: clamp(4rem, 10vw, 8rem) 0 3.25rem;
  }

  .eyebrow {
    margin: 0 0 1.25rem;
    color: var(--sp-color-accent-text);
  }

  h1 {
    max-width: 50rem;
    margin: 0;
    font-size: clamp(2.4rem, 6vw, 4.8rem);
    font-weight: 630;
    letter-spacing: -0.055em;
    line-height: 0.98;
  }

  .lede {
    max-width: 43rem;
    margin: 1.75rem 0 0;
    color: var(--sp-color-text-muted);
    font-size: clamp(1rem, 2vw, 1.15rem);
    line-height: 1.75;
  }

  .runtime-card {
    overflow: hidden;
    max-width: 48rem;
    border: 1px solid var(--sp-color-border);
    border-radius: 0.9rem;
    background: rgba(17, 18, 22, 0.9);
    box-shadow: 0 2rem 5rem rgba(0, 0, 0, 0.24);
  }

  .card-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1.35rem 1.5rem;
    border-bottom: 1px solid var(--sp-color-border);
  }

  .label {
    margin: 0 0 0.35rem;
  }

  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 620;
  }

  .status {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: 999px;
    padding: 0.35rem 0.65rem;
    color: var(--sp-color-text-muted);
    font-size: 0.72rem;
  }

  .status span {
    width: 0.4rem;
    height: 0.4rem;
    border-radius: 999px;
    background: var(--sp-color-text-subtle);
  }

  .status.ready {
    border-color: var(--sp-color-success);
    color: var(--sp-color-success);
  }

  .status.ready span {
    background: var(--sp-color-success);
  }

  .status.error {
    border-color: var(--sp-color-danger);
    color: var(--sp-color-danger);
  }

  .status.error span {
    background: var(--sp-color-danger);
  }

  .status.loading span {
    animation: pulse 1.1s ease-in-out infinite;
  }

  dl {
    margin: 0;
  }

  dl div {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 1rem;
    padding: 1rem 1.5rem;
    border-bottom: 1px solid var(--sp-color-border);
  }

  dt {
    color: var(--sp-color-text-muted);
    font-size: 0.82rem;
  }

  dd {
    margin: 0;
    color: var(--sp-color-text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.75rem;
  }

  dd small {
    margin-left: 0.6rem;
    color: var(--sp-color-text-subtle);
  }

  .request-id {
    margin: 0;
    padding: 0.9rem 1.5rem;
    color: var(--sp-color-text-subtle);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem;
  }

  .failure {
    padding: 1.5rem;
  }

  .failure > p:first-child {
    margin: 0;
    color: var(--sp-color-text);
    line-height: 1.6;
  }

  .failure .request-id {
    padding: 0.75rem 0 0;
  }

  button {
    margin-top: 1.25rem;
    border: 1px solid var(--sp-color-border-strong);
    border-radius: 0.55rem;
    padding: 0.6rem 0.85rem;
    background: var(--sp-color-accent-soft);
    color: var(--sp-color-accent-text);
    cursor: pointer;
  }

  button:hover {
    background: var(--sp-color-surface-hover);
  }

  .loading-rows {
    padding: 0.75rem 1.5rem 1.25rem;
  }

  .loading-rows span {
    display: block;
    height: 2.5rem;
    border-bottom: 1px solid var(--sp-color-border);
    background: linear-gradient(
      90deg,
      transparent,
      rgba(255, 255, 255, 0.025),
      transparent
    );
    background-size: 200% 100%;
    animation: shimmer 1.5s linear infinite;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @keyframes shimmer {
    to {
      background-position: -200% 0;
    }
  }

  @media (max-width: 42rem) {
    .phase {
      display: none;
    }

    .hero {
      padding-top: 4rem;
    }

    dl div {
      grid-template-columns: 1fr;
      gap: 0.35rem;
    }

    dd small {
      float: right;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .status.loading span,
    .loading-rows span {
      animation: none;
    }
  }
</style>
