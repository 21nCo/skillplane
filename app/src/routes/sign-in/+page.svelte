<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { goto } from "$app/navigation";
  import { page } from "$app/state";
  import { resolve } from "$app/paths";
  import { BrandMark } from "@skillplane/ui";
  import {
    AuthClientError,
    saveOtpContext,
    saveReturnTo,
    sendOtp,
  } from "$lib/auth/client.js";
  import { renderTurnstile } from "$lib/auth/turnstile.js";
  import {
    ArrowRightIcon as ArrowRight,
    CheckCircleIcon as CheckCircle,
    MoonIcon as Moon,
    ShieldCheckIcon as ShieldCheck,
    SunIcon as Sun,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";
  import { onMount } from "svelte";

  type FormState =
    | { kind: "ready" }
    | { kind: "submitting" }
    | { kind: "error"; message: string; requestId?: string };

  const siteKey = env.PUBLIC_TURNSTILE_SITE_KEY;
  let email = $state("");
  let formState = $state<FormState>({ kind: "ready" });
  let riskToken = $state("");
  let riskReady = $state(false);
  let turnstileContainer = $state<HTMLElement>();
  let theme = $state<"dark" | "light">("dark");

  function applyTheme(nextTheme: "dark" | "light") {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("skillplane.theme", nextTheme);
  }

  function messageFor(error: AuthClientError): string {
    if (error.code === "AUTH_RATE_LIMITED") {
      return "Too many attempts. Wait a moment before requesting another code.";
    }
    if (
      error.code === "AUTH_RISK_SERVICE_UNAVAILABLE" ||
      error.code === "AUTH_EMAIL_DELIVERY_FAILED"
    ) {
      return "We could not send a code right now. Please try again shortly.";
    }
    return error.message;
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!riskToken || formState.kind === "submitting") return;
    formState = { kind: "submitting" };
    try {
      const result = await sendOtp({
        email: normalizedEmail,
        turnstileToken: riskToken,
      });
      saveOtpContext({
        email: normalizedEmail,
        purpose: "sign-up",
        expiresAt: Date.now() + result.expiresInSeconds * 1_000,
      });
      await goto(resolve("/verify"));
    } catch (error) {
      if (error instanceof AuthClientError) {
        formState = {
          kind: "error",
          message: messageFor(error),
          ...(error.requestId ? { requestId: error.requestId } : {}),
        };
      } else {
        formState = {
          kind: "error",
          message: "Authentication is temporarily unavailable.",
        };
      }
      riskToken = "";
      riskReady = false;
    }
  }

  onMount(() => {
    saveReturnTo(page.url.searchParams.get("next"));
    const preferred =
      localStorage.getItem("skillplane.theme") === "light" ? "light" : "dark";
    applyTheme(preferred);
    if (!siteKey || !turnstileContainer) {
      formState = {
        kind: "error",
        message: "The security check is not configured for this environment.",
      };
      return;
    }
    let remove: (() => void) | undefined;
    void renderTurnstile(turnstileContainer, siteKey, {
      verified(token) {
        riskToken = token;
        riskReady = true;
      },
      unavailable() {
        riskToken = "";
        riskReady = false;
        formState = {
          kind: "error",
          message: "The security check expired. Complete it again to continue.",
        };
      },
    })
      .then((widget) => {
        remove = widget.remove;
      })
      .catch(() => {
        formState = {
          kind: "error",
          message: "The security check could not be loaded. Refresh to try again.",
        };
      });
    return () => remove?.();
  });
</script>

<svelte:head>
  <title>Sign in · Skillplane</title>
  <meta
    name="description"
    content="Sign in to Skillplane with a secure one-time email code."
  />
</svelte:head>

<main class="auth-page">
  <header>
    <a class="brand" href={resolve("/")} aria-label="Skillplane home">
      <BrandMark />
      <span>Skillplane</span>
    </a>
    <button
      class="theme-toggle"
      type="button"
      aria-label={`Use ${theme === "dark" ? "light" : "dark"} theme`}
      onclick={() => applyTheme(theme === "dark" ? "light" : "dark")}
    >
      {#if theme === "dark"}
        <Sun size={17} weight="bold" aria-hidden="true" />
      {:else}
        <Moon size={17} weight="bold" aria-hidden="true" />
      {/if}
    </button>
  </header>

  <section class="auth-layout" aria-labelledby="sign-in-title">
    <div class="product-context">
      <p class="eyebrow">Skills infrastructure</p>
      <h1>Give every agent the right skill, with a history you can trust.</h1>
      <p class="context-copy">
        Create, version, and improve reusable skills while keeping project-specific
        knowledge and agent activity fully auditable.
      </p>
      <ul>
        <li>
          <CheckCircle size={18} weight="fill" aria-hidden="true" /> Versioned by design
        </li>
        <li>
          <CheckCircle size={18} weight="fill" aria-hidden="true" /> Context-aware knowledge
        </li>
        <li>
          <CheckCircle size={18} weight="fill" aria-hidden="true" /> MCP-native access
        </li>
      </ul>
    </div>

    <div class="auth-card">
      <div class="card-icon" aria-hidden="true">
        <ShieldCheck size={22} weight="duotone" aria-hidden="true" />
      </div>
      <p class="card-kicker">Welcome</p>
      <h2 id="sign-in-title">Continue to Skillplane</h2>
      <p class="card-copy">
        Enter your work email. We’ll send a six-digit code—no password required.
      </p>

      <form onsubmit={submit}>
        <label for="email">Work email</label>
        <input
          id="email"
          name="email"
          type="email"
          autocomplete="email"
          maxlength="254"
          placeholder="you@company.com"
          required
          bind:value={email}
          aria-describedby={formState.kind === "error" ? "auth-error" : undefined}
        />

        <div class="risk-check">
          <div bind:this={turnstileContainer}></div>
          {#if riskReady}
            <span class="risk-ready">
              <CheckCircle size={15} weight="fill" aria-hidden="true" /> Security check complete
            </span>
          {/if}
        </div>

        {#if formState.kind === "error"}
          <div class="alert" id="auth-error" role="alert">
            <WarningCircle size={18} weight="fill" aria-hidden="true" />
            <div>
              <p>{formState.message}</p>
              {#if formState.requestId}
                <small>Reference {formState.requestId}</small>
              {/if}
            </div>
          </div>
        {/if}

        <button
          class="primary"
          type="submit"
          disabled={!riskToken || !email.trim() || formState.kind === "submitting"}
        >
          {formState.kind === "submitting" ? "Sending code…" : "Continue with email"}
          <ArrowRight size={17} weight="bold" aria-hidden="true" />
        </button>
      </form>

      <p class="terms">
        By continuing, you agree to Skillplane’s Terms and acknowledge the Privacy
        Policy.
      </p>
    </div>
  </section>
</main>

<style>
  .auth-page {
    width: min(100% - 2rem, 72rem);
    min-height: 100vh;
    margin: 0 auto;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 4.5rem;
    border-bottom: 1px solid var(--border);
  }

  .brand {
    display: inline-flex;
    gap: 0.65rem;
    align-items: center;
    color: var(--text);
    font-size: 0.9rem;
    font-weight: 680;
    text-decoration: none;
  }

  .theme-toggle {
    display: grid;
    width: 2.25rem;
    height: 2.25rem;
    place-items: center;
    border: 1px solid var(--border);
    border-radius: 0.55rem;
    background: var(--surface);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .auth-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(20rem, 26rem);
    gap: clamp(4rem, 9vw, 8rem);
    align-items: center;
    min-height: calc(100vh - 4.5rem);
    padding: 4rem 2rem 5rem;
  }

  .product-context {
    max-width: 35rem;
  }

  .eyebrow,
  .card-kicker {
    margin: 0 0 1rem;
    color: var(--accent-text);
    font-size: 0.7rem;
    font-weight: 720;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: clamp(2.45rem, 5vw, 4.25rem);
    font-weight: 630;
    letter-spacing: -0.055em;
    line-height: 1.01;
  }

  .context-copy {
    max-width: 33rem;
    margin: 1.6rem 0 0;
    color: var(--text-secondary);
    font-size: 1.02rem;
    line-height: 1.7;
  }

  ul {
    display: flex;
    flex-wrap: wrap;
    gap: 0.7rem 1.25rem;
    margin: 2rem 0 0;
    padding: 0;
    color: var(--text-secondary);
    font-size: 0.78rem;
    list-style: none;
  }

  li {
    display: inline-flex;
    gap: 0.45rem;
    align-items: center;
  }

  li :global(svg) {
    color: var(--success);
  }

  .auth-card {
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    padding: 2rem;
    background: var(--surface-raised);
    box-shadow: 0 1.5rem 4rem var(--shadow);
  }

  .card-icon {
    display: grid;
    width: 2.65rem;
    height: 2.65rem;
    margin-bottom: 1.7rem;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    border-radius: 0.7rem;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .card-kicker {
    margin-bottom: 0.55rem;
  }

  h2 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 650;
    letter-spacing: -0.025em;
  }

  .card-copy {
    margin: 0.7rem 0 1.6rem;
    color: var(--text-secondary);
    font-size: 0.88rem;
    line-height: 1.55;
  }

  form {
    display: grid;
    gap: 0.75rem;
  }

  label {
    color: var(--text);
    font-size: 0.78rem;
    font-weight: 600;
  }

  input {
    width: 100%;
    height: 2.75rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.55rem;
    padding: 0 0.8rem;
    background: var(--surface);
    color: var(--text);
    outline: none;
    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  input::placeholder {
    color: var(--text-tertiary);
  }

  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
  }

  .risk-check {
    min-height: 4rem;
    padding-top: 0.2rem;
  }

  .risk-ready {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    margin-top: 0.4rem;
    color: var(--success);
    font-size: 0.72rem;
  }

  .alert {
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 0.65rem;
    border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
    border-radius: 0.55rem;
    padding: 0.75rem;
    background: var(--danger-soft);
    color: var(--danger);
    font-size: 0.78rem;
    line-height: 1.45;
  }

  .alert p {
    margin: 0;
  }

  .alert small {
    display: block;
    margin-top: 0.2rem;
    color: var(--text-tertiary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.63rem;
  }

  .primary {
    display: flex;
    gap: 0.55rem;
    align-items: center;
    justify-content: center;
    height: 2.8rem;
    margin-top: 0.15rem;
    border: 0;
    border-radius: 0.55rem;
    background: var(--accent);
    color: var(--sp-color-surface);
    font-size: 0.84rem;
    font-weight: 650;
    cursor: pointer;
    transition:
      background 120ms ease,
      transform 120ms ease;
  }

  .primary:hover:not(:disabled) {
    background: var(--accent-hover);
    transform: translateY(-1px);
  }

  .primary:disabled {
    opacity: 0.48;
    cursor: not-allowed;
  }

  .terms {
    margin: 1.25rem 0 0;
    color: var(--text-tertiary);
    font-size: 0.67rem;
    line-height: 1.55;
    text-align: center;
  }

  @media (max-width: 800px) {
    .auth-layout {
      grid-template-columns: 1fr;
      gap: 3rem;
      padding: 3rem 0 4rem;
    }

    .product-context {
      max-width: 39rem;
    }

    .auth-card {
      width: min(100%, 28rem);
    }
  }

  @media (max-width: 520px) {
    .auth-layout {
      padding-top: 2.5rem;
    }

    .product-context {
      display: none;
    }

    .auth-card {
      padding: 1.5rem;
    }
  }
</style>
