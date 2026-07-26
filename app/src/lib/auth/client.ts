export type OtpPurpose = "sign-up";

export interface OtpContext {
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly expiresAt: number;
}

export interface BrowserSession {
  readonly id: string;
  readonly actorType: "user";
  readonly actorId: string;
  readonly methods: readonly string[];
  readonly subject: {
    readonly actorId: string;
    readonly actorType: "user";
    readonly email?: string;
  };
}

interface ErrorEnvelope {
  readonly ok: false;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly retryable?: boolean;
  };
  readonly requestId?: string;
}

interface SuccessEnvelope<T> {
  readonly ok: true;
  readonly data: T;
  readonly requestId: string;
}

export class AuthClientError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    status: number,
    code: string,
    message: string,
    retryable: boolean,
    requestId?: string,
  ) {
    super(message);
    this.name = "AuthClientError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
    if (requestId) this.requestId = requestId;
  }
}

const OTP_CONTEXT_KEY = "skillplane.auth.otp";
const RETURN_TO_KEY = "skillplane.auth.return-to";

async function authRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<SuccessEnvelope<T>> {
  let response: Response;
  try {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    if (init.body) headers.set("content-type", "application/json");
    response = await fetch(path, {
      ...init,
      credentials: "include",
      headers,
    });
  } catch {
    throw new AuthClientError(
      0,
      "AUTH_NETWORK_ERROR",
      "We could not reach Skillplane. Check your connection and try again.",
      true,
    );
  }

  let body: SuccessEnvelope<T> | ErrorEnvelope;
  try {
    body = (await response.json()) as SuccessEnvelope<T> | ErrorEnvelope;
  } catch {
    throw new AuthClientError(
      response.status,
      "AUTH_RESPONSE_INVALID",
      "Authentication is temporarily unavailable.",
      true,
    );
  }
  if (!response.ok || !body.ok) {
    const error = body.ok ? undefined : body.error;
    throw new AuthClientError(
      response.status,
      error?.code ?? "AUTH_REQUEST_FAILED",
      error?.message ?? "Authentication is temporarily unavailable.",
      error?.retryable ?? response.status >= 500,
      body.requestId,
    );
  }
  return body;
}

export async function sendOtp(input: {
  readonly email: string;
  readonly turnstileToken: string;
}): Promise<{ readonly expiresInSeconds: number }> {
  const response = await authRequest<{
    readonly accepted: true;
    readonly expiresInSeconds: number;
  }>("/auth/otp/send", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      purpose: "sign-up",
      turnstileToken: input.turnstileToken,
    }),
  });
  return { expiresInSeconds: response.data.expiresInSeconds };
}

export async function verifyOtp(input: {
  readonly email: string;
  readonly code: string;
}): Promise<void> {
  await authRequest("/auth/otp/verify", {
    method: "POST",
    body: JSON.stringify({
      email: input.email,
      code: input.code,
      purpose: "sign-up",
    }),
  });
}

export async function getSession(): Promise<BrowserSession | null> {
  const response = await authRequest<{
    readonly session: BrowserSession | null;
  }>("/auth/session");
  return response.data.session;
}

export async function signOut(): Promise<void> {
  const csrf = document.cookie
    .split(";")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith("skillplane.csrf="))
    ?.slice("skillplane.csrf=".length);
  await authRequest("/auth/sign-out", {
    method: "POST",
    headers: csrf ? { "x-authfn-csrf": decodeURIComponent(csrf) } : undefined,
    body: "{}",
  });
}

export function saveOtpContext(context: OtpContext): void {
  sessionStorage.setItem(OTP_CONTEXT_KEY, JSON.stringify(context));
}

export function loadOtpContext(): OtpContext | null {
  const raw = sessionStorage.getItem(OTP_CONTEXT_KEY);
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const context = value as Partial<OtpContext>;
    if (
      typeof context.email !== "string" ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(context.email) ||
      context.purpose !== "sign-up" ||
      typeof context.expiresAt !== "number" ||
      !Number.isFinite(context.expiresAt)
    ) {
      return null;
    }
    return {
      email: context.email,
      purpose: context.purpose,
      expiresAt: context.expiresAt,
    };
  } catch {
    return null;
  }
}

export function clearOtpContext(): void {
  sessionStorage.removeItem(OTP_CONTEXT_KEY);
}

export function saveReturnTo(value: string | null): void {
  if (!value || !value.startsWith("/") || value.startsWith("//")) {
    sessionStorage.removeItem(RETURN_TO_KEY);
    return;
  }
  sessionStorage.setItem(RETURN_TO_KEY, value);
}

export function takeReturnTo(): string | null {
  const value = sessionStorage.getItem(RETURN_TO_KEY);
  sessionStorage.removeItem(RETURN_TO_KEY);
  return value && value.startsWith("/") && !value.startsWith("//") ? value : null;
}
