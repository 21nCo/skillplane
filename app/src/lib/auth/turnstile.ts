const TURNSTILE_SCRIPT =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

interface TurnstileApi {
  render(
    container: HTMLElement,
    options: {
      readonly action: string;
      readonly appearance: "always";
      readonly callback: (token: string) => void;
      readonly "error-callback": () => void;
      readonly "expired-callback": () => void;
      readonly sitekey: string;
      readonly theme: "auto";
    },
  ): string;
  reset(widgetId: string): void;
  remove(widgetId: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | undefined;

function waitForApi(resolve: (api: TurnstileApi) => void, reject: () => void) {
  const startedAt = Date.now();
  const poll = () => {
    if (window.turnstile) {
      resolve(window.turnstile);
      return;
    }
    if (Date.now() - startedAt > 10_000) {
      reject();
      return;
    }
    window.setTimeout(poll, 50);
  };
  poll();
}

export function loadTurnstile(): Promise<TurnstileApi> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${TURNSTILE_SCRIPT}"]`,
    );
    if (!existing) {
      const script = document.createElement("script");
      script.src = TURNSTILE_SCRIPT;
      script.async = true;
      script.defer = true;
      script.onerror = () =>
        reject(new Error("The security check could not be loaded"));
      document.head.append(script);
    }
    waitForApi(resolve, () => reject(new Error("The security check timed out")));
  });
  return loading;
}

export async function renderTurnstile(
  container: HTMLElement,
  siteKey: string,
  callbacks: {
    readonly verified: (token: string) => void;
    readonly unavailable: () => void;
  },
): Promise<{ readonly reset: () => void; readonly remove: () => void }> {
  const api = await loadTurnstile();
  const widgetId = api.render(container, {
    sitekey: siteKey,
    action: "otp_send",
    appearance: "always",
    theme: "auto",
    callback: callbacks.verified,
    "expired-callback": callbacks.unavailable,
    "error-callback": callbacks.unavailable,
  });
  return {
    reset: () => api.reset(widgetId),
    remove: () => api.remove(widgetId),
  };
}
