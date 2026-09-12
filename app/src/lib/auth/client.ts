import {
  createAuthFnClient,
  type AuthFnErrorEnvelope,
  type AuthFnSession,
} from "@authfn/client";

export type OtpPurpose = "sign-up";
export interface OtpContext {
  readonly email: string;
  readonly purpose: OtpPurpose;
  readonly expiresAt: number;
}
export type BrowserSession = AuthFnSession;

export class AuthClientError extends Error {
  readonly code: string;
  readonly requestId?: string;
  readonly retryable: boolean;
  constructor(error: AuthFnErrorEnvelope) {
    super(error.error.message);
    this.name = "AuthClientError";
    this.code = error.error.code;
    this.retryable = error.error.retryable;
    this.requestId = error.requestId;
  }
}

const client = createAuthFnClient({ baseUrl: "/auth", credentials: "include" });
const OTP_CONTEXT_KEY = "skillplane.auth.otp";
const RETURN_TO_KEY = "skillplane.auth.return-to";

function isErrorEnvelope(result: unknown): result is AuthFnErrorEnvelope {
  return (
    typeof result === "object" &&
    result !== null &&
    "ok" in result &&
    result.ok === false
  );
}

function unwrap<T>(result: T | AuthFnErrorEnvelope): T {
  if (isErrorEnvelope(result)) {
    throw new AuthClientError(result);
  }
  return result;
}

export async function sendOtp(input: {
  readonly email: string;
  readonly turnstileToken: string;
}): Promise<{ readonly expiresInSeconds: number }> {
  unwrap(
    await client.sendOtp({
      email: input.email,
      purpose: "sign-up",
      metadata: { turnstileToken: input.turnstileToken },
    }),
  );
  return { expiresInSeconds: 600 };
}

export async function verifyOtp(input: {
  readonly email: string;
  readonly code: string;
}): Promise<void> {
  unwrap(
    await client.verifyOtp({
      email: input.email,
      code: input.code,
      purpose: "sign-up",
      sessionMode: "cookie",
    }),
  );
}

export async function getSession(): Promise<BrowserSession | null> {
  return unwrap(await client.getSession()).data.session;
}

export async function signOut(): Promise<void> {
  unwrap(await client.signOut());
}

export function saveOtpContext(context: OtpContext): void {
  sessionStorage.setItem(OTP_CONTEXT_KEY, JSON.stringify(context));
}
export function loadOtpContext(): OtpContext | null {
  const raw = sessionStorage.getItem(OTP_CONTEXT_KEY);
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<OtpContext>;
    return typeof value.email === "string" &&
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.email) &&
      value.purpose === "sign-up" &&
      typeof value.expiresAt === "number" &&
      Number.isFinite(value.expiresAt)
      ? { email: value.email, purpose: value.purpose, expiresAt: value.expiresAt }
      : null;
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
