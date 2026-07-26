import type { AuthFnInstance, AuthFnOtpPurpose } from "@authfn/core";
import { Hono } from "hono";
import type { OtpRateLimiter } from "./rate-limit.js";
import type { TurnstileVerifier } from "./turnstile.js";

interface OtpRequestBody {
  readonly email?: unknown;
  readonly code?: unknown;
  readonly purpose?: unknown;
  readonly turnstileToken?: unknown;
}

export interface CreateAuthApplicationInput {
  readonly authfn: AuthFnInstance;
  readonly rateLimiter?: OtpRateLimiter;
  readonly turnstile?: TurnstileVerifier;
}

const OTP_PURPOSES = new Set<AuthFnOtpPurpose>([
  "verify-email",
  "sign-in",
  "sign-up",
  "reset-password",
]);

function requestId(request: Request): string {
  const incoming = request.headers.get("x-request-id")?.trim();
  return incoming?.length ? incoming : `req_${crypto.randomUUID()}`;
}

function failure(
  request: Request,
  status: number,
  code: string,
  message: string,
  retryable = false,
  headers?: HeadersInit,
): Response {
  const id = requestId(request);
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  responseHeaders.set("cache-control", "private, no-store");
  responseHeaders.set("x-request-id", id);
  return new Response(
    JSON.stringify({
      ok: false,
      error: { code, message, retryable },
      requestId: id,
    }),
    { status, headers: responseHeaders },
  );
}

function success(
  request: Request,
  data: Record<string, unknown>,
  headers?: HeadersInit,
): Response {
  const id = requestId(request);
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json");
  responseHeaders.set("cache-control", "private, no-store");
  responseHeaders.set("x-request-id", id);
  return new Response(JSON.stringify({ ok: true, data, requestId: id }), {
    status: 200,
    headers: responseHeaders,
  });
}

async function readBody(request: Request): Promise<OtpRequestBody | null> {
  try {
    const body: unknown = await request.json();
    return typeof body === "object" && body !== null ? body : null;
  } catch {
    return null;
  }
}

function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email.length <= 254 &&
    !/[\r\n<>]/.test(email) &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
    ? email
    : null;
}

function readPurpose(value: unknown): AuthFnOtpPurpose {
  return typeof value === "string" && OTP_PURPOSES.has(value as AuthFnOtpPurpose)
    ? (value as AuthFnOtpPurpose)
    : "sign-up";
}

function networkIdentity(request: Request): string {
  const incoming = request.headers.get("cf-connecting-ip")?.trim();
  return incoming?.length ? incoming : "unknown";
}

async function delegateOtp(
  authfn: AuthFnInstance,
  request: Request,
  body: Record<string, unknown>,
): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.set("content-type", "application/json");
  return authfn.router.handle(
    new Request(request.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

async function readAuthFnError(
  response: Response,
): Promise<{ readonly code?: string }> {
  try {
    const body: unknown = await response.clone().json();
    if (!body || typeof body !== "object") return {};
    const error = (body as { readonly error?: unknown }).error;
    if (!error || typeof error !== "object") return {};
    const code = (error as { readonly code?: unknown }).code;
    return typeof code === "string" ? { code } : {};
  } catch {
    return {};
  }
}

export function createAuthApplication(input: CreateAuthApplicationInput) {
  const app = new Hono();

  app.post("/auth/otp/send", async (context) => {
    const request = context.req.raw;
    const body = await readBody(request.clone());
    const email = normalizeEmail(body?.email);
    if (!body || !email) {
      return failure(request, 400, "AUTH_EMAIL_INVALID", "Enter a valid email address");
    }
    if (!input.turnstile || !input.rateLimiter) {
      return failure(
        request,
        503,
        "AUTH_CONFIGURATION_INVALID",
        "Authentication is temporarily unavailable",
        true,
      );
    }
    const verification = await input.turnstile.verify({
      token: typeof body.turnstileToken === "string" ? body.turnstileToken : "",
      remoteIp: networkIdentity(request),
      idempotencyKey: requestId(request),
    });
    if (!verification.success) {
      return failure(
        request,
        verification.reason === "unavailable" ? 503 : 429,
        verification.reason === "unavailable"
          ? "AUTH_RISK_SERVICE_UNAVAILABLE"
          : "AUTH_RATE_LIMITED",
        verification.reason === "unavailable"
          ? "Authentication is temporarily unavailable"
          : "Please wait before trying again",
        true,
      );
    }
    const rate = await input.rateLimiter.consume({
      email,
      network: networkIdentity(request),
    });
    const rateHeaders = {
      "x-ratelimit-remaining": String(rate.remaining),
      ...(rate.allowed ? {} : { "retry-after": String(rate.retryAfterSeconds) }),
    };
    if (!rate.allowed) {
      return failure(
        request,
        429,
        "AUTH_RATE_LIMITED",
        "Please wait before trying again",
        true,
        rateHeaders,
      );
    }

    const delegated = await delegateOtp(input.authfn, request, {
      email,
      purpose: readPurpose(body.purpose),
    });
    if (!delegated.ok) {
      return failure(
        request,
        503,
        "AUTH_EMAIL_DELIVERY_FAILED",
        "The verification email could not be sent",
        true,
        rateHeaders,
      );
    }
    return success(
      request,
      {
        accepted: true,
        expiresInSeconds: 600,
      },
      rateHeaders,
    );
  });

  app.post("/auth/otp/verify", async (context) => {
    const request = context.req.raw;
    const body = await readBody(request.clone());
    const email = normalizeEmail(body?.email);
    const code =
      typeof body?.code === "string" && /^\d{6}$/.test(body.code) ? body.code : null;
    if (!body || !email || !code) {
      return failure(
        request,
        400,
        "AUTH_OTP_INVALID",
        "The verification code is invalid or no longer available",
      );
    }
    const delegated = await delegateOtp(input.authfn, request, {
      email,
      code,
      purpose: readPurpose(body.purpose),
      sessionMode: "cookie",
    });
    if (delegated.ok) return delegated;
    const error = await readAuthFnError(delegated);
    if (error.code === "AUTHFN_OTP_EXPIRED") {
      return failure(
        request,
        400,
        "AUTH_OTP_EXPIRED",
        "The verification code has expired",
      );
    }
    return failure(
      request,
      400,
      "AUTH_OTP_INVALID",
      "The verification code is invalid or no longer available",
    );
  });

  app.all("/auth/*", (context) => input.authfn.router.handle(context.req.raw));

  return app;
}
