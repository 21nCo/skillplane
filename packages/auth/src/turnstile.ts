export interface TurnstileVerificationInput {
  readonly token: string;
  readonly remoteIp?: string;
  readonly idempotencyKey?: string;
}

export interface TurnstileVerification {
  readonly success: boolean;
  readonly reason: "verified" | "invalid" | "unavailable";
}

export interface TurnstileVerifier {
  verify(input: TurnstileVerificationInput): Promise<TurnstileVerification>;
}

interface TurnstileSiteverifyResponse {
  readonly success?: boolean;
  readonly action?: string;
  readonly hostname?: string;
  readonly metadata?: {
    readonly result_with_testing_key?: boolean;
  };
}

export interface CloudflareTurnstileVerifierOptions {
  readonly secretKey: string;
  readonly expectedAction: string;
  readonly allowedHostnames: readonly string[];
  readonly allowTestingKeyResponse?: boolean;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
}

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function siteverifyIdempotencyKey(value: string | undefined): string {
  if (value && UUID_PATTERN.test(value)) return value;
  const prefixed = value?.startsWith("req_") ? value.slice(4) : undefined;
  return prefixed && UUID_PATTERN.test(prefixed) ? prefixed : crypto.randomUUID();
}

function isSiteverifyResponse(value: unknown): value is TurnstileSiteverifyResponse {
  return typeof value === "object" && value !== null;
}

export class CloudflareTurnstileVerifier implements TurnstileVerifier {
  readonly #secretKey: string;
  readonly #expectedAction: string;
  readonly #allowedHostnames: ReadonlySet<string>;
  readonly #allowTestingKeyResponse: boolean;
  readonly #fetcher: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: CloudflareTurnstileVerifierOptions) {
    if (options.secretKey.length < 20) {
      throw new Error("Turnstile secret is invalid");
    }
    if (!/^[a-zA-Z0-9_-]{1,32}$/.test(options.expectedAction)) {
      throw new Error("Turnstile action is invalid");
    }
    if (options.allowedHostnames.length === 0) {
      throw new Error("At least one Turnstile hostname is required");
    }
    this.#secretKey = options.secretKey;
    this.#expectedAction = options.expectedAction;
    this.#allowedHostnames = new Set(options.allowedHostnames);
    this.#allowTestingKeyResponse = options.allowTestingKeyResponse ?? false;
    this.#fetcher = options.fetcher ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.timeoutMs ?? 8_000;
  }

  async verify(input: TurnstileVerificationInput): Promise<TurnstileVerification> {
    if (!input.token || input.token.length > 2_048) {
      return { success: false, reason: "invalid" };
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
    try {
      const response = await this.#fetcher(SITEVERIFY_URL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: this.#secretKey,
          response: input.token,
          ...(input.remoteIp ? { remoteip: input.remoteIp } : {}),
          idempotency_key: siteverifyIdempotencyKey(input.idempotencyKey),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        return { success: false, reason: "unavailable" };
      }
      const result: unknown = await response.json();
      if (!isSiteverifyResponse(result) || !result.success) {
        return { success: false, reason: "invalid" };
      }
      if (
        this.#allowTestingKeyResponse &&
        result.metadata?.result_with_testing_key === true
      ) {
        return { success: true, reason: "verified" };
      }
      if (
        result.action !== this.#expectedAction ||
        !result.hostname ||
        !this.#allowedHostnames.has(result.hostname)
      ) {
        return { success: false, reason: "invalid" };
      }
      return { success: true, reason: "verified" };
    } catch {
      return { success: false, reason: "unavailable" };
    } finally {
      clearTimeout(timeout);
    }
  }
}
