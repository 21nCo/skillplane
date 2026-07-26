<script lang="ts">
  import { env } from "$env/dynamic/public";
  import { resolve } from "$app/paths";
  import {
    AuthClientError,
    clearOtpContext,
    loadOtpContext,
    saveOtpContext,
    sendOtp,
    takeReturnTo,
    verifyOtp,
    type OtpContext,
  } from "$lib/auth/client.js";
  import { renderTurnstile } from "$lib/auth/turnstile.js";
  import {
    ArrowLeftIcon as ArrowLeft,
    ArrowRightIcon as ArrowRight,
    CheckCircleIcon as CheckCircle,
    ClockCountdownIcon as ClockCountdown,
    EnvelopeSimpleIcon as EnvelopeSimple,
    MoonIcon as Moon,
    SunIcon as Sun,
    WarningCircleIcon as WarningCircle,
  } from "phosphor-svelte";
  import { onMount, tick } from "svelte";

  type VerifyState =
    | { kind: "loading" }
    | { kind: "recovery" }
    | { kind: "ready" }
    | { kind: "verifying" }
    | { kind: "resending" }
    | { kind: "invalid"; message: string }
    | { kind: "expired"; message: string }
    | { kind: "rate"; message: string; requestId?: string }
    | { kind: "error"; message: string; requestId?: string }
    | { kind: "success" };

  const siteKey = env.PUBLIC_TURNSTILE_SITE_KEY;
  let context = $state<OtpContext | null>(null);
  let code = $state("");
  let verifyState = $state<VerifyState>({ kind: "loading" });
  let secondsRemaining = $state(0);
  let riskToken = $state("");
  let turnstileContainer = $state<HTMLElement>();
  let resetTurnstile: (() => void) | undefined;
  let theme = $state<"dark" | "light">("dark");

  function applyTheme(nextTheme: "dark" | "light") {
    theme = nextTheme;
    document.documentElement.dataset.theme = nextTheme;
    localStorage.setItem("skillplane.theme", nextTheme);
  }

  function updateCountdown() {
    if (!context) return;
    secondsRemaining = Math.max(0, Math.ceil((context.expiresAt - Date.now()) / 1_000));
    if (
      secondsRemaining === 0 &&
      !["resending", "success", "recovery"].includes(verifyState.kind)
    ) {
      verifyState = {
        kind: "expired",
        message: "This code has expired. Request a new one to continue.",
      };
    }
  }

  function normalizeCode(value: string) {
    code = value.replace(/\D/g, "").slice(0, 6);
    if (verifyState.kind === "invalid") verifyState = { kind: "ready" };
  }

  async function verify(event: SubmitEvent) {
    event.preventDefault();
    if (!context || code.length !== 6 || verifyState.kind === "verifying") return;
    if (Date.now() >= context.expiresAt) {
      verifyState = {
        kind: "expired",
        message: "This code has expired. Request a new one to continue.",
      };
      return;
    }
    verifyState = { kind: "verifying" };
    try {
      await verifyOtp({ email: context.email, code });
      verifyState = { kind: "success" };
      clearOtpContext();
      window.location.assign(takeReturnTo() ?? resolve("/"));
    } catch (error) {
      if (error instanceof AuthClientError) {
        if (error.code === "AUTH_OTP_EXPIRED") {
          verifyState = { kind: "expired", message: error.message };
        } else if (error.code === "AUTH_OTP_INVALID") {
          verifyState = {
            kind: "invalid",
            message: "That code is not valid. Check the email and try again.",
          };
        } else {
          verifyState = {
            kind: "error",
            message: error.message,
            ...(error.requestId ? { requestId: error.requestId } : {}),
          };
        }
      } else {
        verifyState = {
          kind: "error",
          message: "We could not verify the code. Try again.",
        };
      }
    }
  }

  async function resend() {
    if (!context || !riskToken || verifyState.kind === "resending") return;
    verifyState = { kind: "resending" };
    try {
      const result = await sendOtp({
        email: context.email,
        turnstileToken: riskToken,
      });
      context = {
        ...context,
        expiresAt: Date.now() + result.expiresInSeconds * 1_000,
      };
      saveOtpContext(context);
      code = "";
      verifyState = { kind: "ready" };
      riskToken = "";
      resetTurnstile?.();
      updateCountdown();
    } catch (error) {
      if (error instanceof AuthClientError && error.code === "AUTH_RATE_LIMITED") {
        verifyState = {
          kind: "rate",
          message: "Too many requests. Wait a moment before sending another code.",
          ...(error.requestId ? { requestId: error.requestId } : {}),
        };
      } else if (error instanceof AuthClientError) {
        verifyState = {
          kind: "error",
          message: "A new code could not be sent. Please try again shortly.",
          ...(error.requestId ? { requestId: error.requestId } : {}),
        };
      } else {
        verifyState = {
          kind: "error",
          message: "A new code could not be sent. Please try again shortly.",
        };
      }
      riskToken = "";
      resetTurnstile?.();
    }
  }

  onMount(() => {
    applyTheme(localStorage.getItem("skillplane.theme") === "light" ? "light" : "dark");
    context = loadOtpContext();
    if (!context) {
      verifyState = { kind: "recovery" };
      return;
    }
    verifyState =
      context.expiresAt <= Date.now()
        ? {
            kind: "expired",
            message: "This code has expired. Request a new one to continue.",
          }
        : { kind: "ready" };
    updateCountdown();
    const interval = window.setInterval(updateCountdown, 1_000);
    let remove: (() => void) | undefined;
    void (async () => {
      await tick();
      if (!siteKey || !turnstileContainer) return;
      const widget = await renderTurnstile(turnstileContainer, siteKey, {
        verified(token) {
          riskToken = token;
        },
        unavailable() {
          riskToken = "";
        },
      });
      resetTurnstile = widget.reset;
      remove = widget.remove;
    })().catch(() => {
      verifyState = {
        kind: "error",
        message:
          "The security check could not be loaded. Refresh before requesting a new code.",
      };
    });
    return () => {
      window.clearInterval(interval);
      remove?.();
    };
  });
</script>

<svelte:head>
  <title>Verify your email · Skillplane</title>
  <meta
    name="description"
    content="Verify your email with a secure Skillplane one-time code."
  />
</svelte:head>

<main class="verify-page">
  <header>
    <a class="brand" href={resolve("/")} aria-label="Skillplane home">
      <span class="brand-mark" aria-hidden="true">S</span>
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

  <section class="verify-layout" aria-labelledby="verify-title">
    {#if verifyState.kind === "loading"}
      <div class="verify-card loading" aria-label="Loading verification">
        <span></span><span></span><span></span>
      </div>
    {:else if verifyState.kind === "recovery"}
      <div class="verify-card recovery">
        <div class="card-icon danger" aria-hidden="true">
          <WarningCircle size={23} weight="duotone" aria-hidden="true" />
        </div>
        <p class="card-kicker">Verification unavailable</p>
        <h1 id="verify-title">Start with your email</h1>
        <p class="card-copy">
          This verification link has no active request. Return to sign in and ask for a
          new code.
        </p>
        <a class="primary" href={resolve("/sign-in")}>
          Back to sign in <ArrowRight size={17} weight="bold" aria-hidden="true" />
        </a>
      </div>
    {:else}
      <div class="verify-card">
        <a class="back" href={resolve("/sign-in")}>
          <ArrowLeft size={15} weight="bold" aria-hidden="true" /> Use another email
        </a>
        <div class="card-icon" aria-hidden="true">
          <EnvelopeSimple size={23} weight="duotone" aria-hidden="true" />
        </div>
        <p class="card-kicker">Check your inbox</p>
        <h1 id="verify-title">Enter your verification code</h1>
        <p class="card-copy">
          We sent a six-digit code to <strong>{context?.email}</strong>. The same
          response is shown whether an account already exists or not.
        </p>

        <form onsubmit={verify}>
          <label for="code">Verification code</label>
          <input
            id="code"
            name="code"
            type="text"
            inputmode="numeric"
            autocomplete="one-time-code"
            maxlength="6"
            placeholder="000000"
            value={code}
            oninput={(event) => normalizeCode(event.currentTarget.value)}
            aria-invalid={verifyState.kind === "invalid"}
            aria-describedby={["invalid", "expired", "rate", "error"].includes(
              verifyState.kind,
            )
              ? "verify-error"
              : "countdown"}
          />

          <div class="countdown" id="countdown">
            <ClockCountdown size={16} weight="duotone" aria-hidden="true" />
            {#if secondsRemaining > 0}
              Expires in {Math.floor(secondsRemaining / 60)}:{String(
                secondsRemaining % 60,
              ).padStart(2, "0")}
            {:else}
              Code expired
            {/if}
          </div>

          {#if verifyState.kind === "invalid" || verifyState.kind === "expired" || verifyState.kind === "rate" || verifyState.kind === "error"}
            <div class="alert" id="verify-error" role="alert">
              <WarningCircle size={18} weight="fill" aria-hidden="true" />
              <div>
                <p>{verifyState.message}</p>
                {#if "requestId" in verifyState && verifyState.requestId}
                  <small>Reference {verifyState.requestId}</small>
                {/if}
              </div>
            </div>
          {/if}

          {#if verifyState.kind === "success"}
            <div class="success" role="status">
              <CheckCircle size={18} weight="fill" aria-hidden="true" /> Verified. Opening
              Skillplane…
            </div>
          {/if}

          <button
            class="primary"
            type="submit"
            disabled={code.length !== 6 ||
              ["verifying", "success", "expired"].includes(verifyState.kind)}
          >
            {verifyState.kind === "verifying" ? "Verifying…" : "Verify and continue"}
            <ArrowRight size={17} weight="bold" aria-hidden="true" />
          </button>
        </form>

        <div class="resend">
          <div class="risk-check" bind:this={turnstileContainer}></div>
          <p>Didn’t receive it?</p>
          <button
            type="button"
            onclick={() => void resend()}
            disabled={!riskToken || verifyState.kind === "resending"}
          >
            {verifyState.kind === "resending" ? "Sending…" : "Send a new code"}
          </button>
        </div>
      </div>
    {/if}
  </section>
</main>

<style>
  .verify-page {
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

  .brand-mark {
    display: grid;
    width: 1.75rem;
    height: 1.75rem;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent) 70%, var(--border));
    border-radius: 0.48rem;
    background: var(--accent-soft);
    color: var(--accent-text);
    font-size: 0.76rem;
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

  .verify-layout {
    display: grid;
    min-height: calc(100vh - 4.5rem);
    place-items: center;
    padding: 3.5rem 0 5rem;
  }

  .verify-card {
    width: min(100%, 27rem);
    border: 1px solid var(--border);
    border-radius: 0.9rem;
    padding: 2rem;
    background: var(--surface-raised);
    box-shadow: 0 1.5rem 4rem var(--shadow);
  }

  .back {
    display: inline-flex;
    gap: 0.4rem;
    align-items: center;
    margin-bottom: 2rem;
    color: var(--text-tertiary);
    font-size: 0.73rem;
    font-weight: 550;
    text-decoration: none;
  }

  .back:hover {
    color: var(--text);
  }

  .card-icon {
    display: grid;
    width: 2.65rem;
    height: 2.65rem;
    margin-bottom: 1.6rem;
    place-items: center;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--border));
    border-radius: 0.7rem;
    background: var(--accent-soft);
    color: var(--accent-text);
  }

  .card-icon.danger {
    border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
    background: var(--danger-soft);
    color: var(--danger);
  }

  .card-kicker {
    margin: 0 0 0.55rem;
    color: var(--accent-text);
    font-size: 0.7rem;
    font-weight: 720;
    letter-spacing: 0.09em;
    text-transform: uppercase;
  }

  h1 {
    margin: 0;
    font-size: 1.55rem;
    font-weight: 650;
    letter-spacing: -0.03em;
    line-height: 1.2;
  }

  .card-copy {
    margin: 0.8rem 0 1.7rem;
    color: var(--text-secondary);
    font-size: 0.86rem;
    line-height: 1.6;
  }

  .card-copy strong {
    color: var(--text);
    font-weight: 600;
    overflow-wrap: anywhere;
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
    height: 3.4rem;
    border: 1px solid var(--border-strong);
    border-radius: 0.6rem;
    padding: 0 1rem;
    background: var(--surface);
    color: var(--text);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 1.45rem;
    font-weight: 650;
    letter-spacing: 0.3em;
    outline: none;
    text-align: center;
  }

  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
  }

  input[aria-invalid="true"] {
    border-color: var(--danger);
  }

  input::placeholder {
    color: var(--text-tertiary);
    opacity: 0.55;
  }

  .countdown {
    display: flex;
    gap: 0.4rem;
    align-items: center;
    color: var(--text-tertiary);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.68rem;
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

  .success {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    color: var(--success);
    font-size: 0.78rem;
  }

  .primary {
    display: flex;
    gap: 0.55rem;
    align-items: center;
    justify-content: center;
    min-height: 2.8rem;
    border: 0;
    border-radius: 0.55rem;
    background: var(--accent);
    color: var(--sp-color-surface);
    font-size: 0.84rem;
    font-weight: 650;
    text-decoration: none;
    cursor: pointer;
  }

  .primary:hover:not(:disabled) {
    background: var(--accent-hover);
  }

  .primary:disabled {
    opacity: 0.46;
    cursor: not-allowed;
  }

  .recovery .primary {
    margin-top: 1.6rem;
  }

  .resend {
    margin-top: 1.3rem;
    border-top: 1px solid var(--border);
    padding-top: 1.1rem;
    text-align: center;
  }

  .risk-check {
    min-height: 4rem;
  }

  .resend p {
    display: inline;
    margin: 0;
    color: var(--text-tertiary);
    font-size: 0.72rem;
  }

  .resend button {
    border: 0;
    padding: 0.25rem;
    background: transparent;
    color: var(--accent-text);
    font-size: 0.72rem;
    font-weight: 620;
    cursor: pointer;
  }

  .resend button:disabled {
    color: var(--text-tertiary);
    cursor: not-allowed;
  }

  .loading {
    display: grid;
    gap: 0.75rem;
  }

  .loading span {
    height: 1rem;
    border-radius: 0.35rem;
    background: var(--surface-subtle);
    animation: pulse 1s ease-in-out infinite alternate;
  }

  .loading span:nth-child(2) {
    width: 74%;
  }

  .loading span:nth-child(3) {
    width: 48%;
  }

  @keyframes pulse {
    to {
      opacity: 0.45;
    }
  }

  @media (max-width: 520px) {
    .verify-card {
      padding: 1.5rem;
    }

    .verify-layout {
      align-items: start;
      padding-top: 2.5rem;
    }
  }
</style>
