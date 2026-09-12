import { AuthFnConfigError, AuthFnRateLimitedError } from "authfn";
import type { AuthFnDeliveryFailedError } from "authfn/core/errors";
import { describe, expect, it, vi } from "vitest";
import { createOtpPolicyHook } from "./otp-policy.js";

const request = new Request("https://skillplane.test/auth/otp/send", {
  method: "POST",
  headers: { "cf-connecting-ip": "192.0.2.1", "x-request-id": "req_test" },
});

describe("AuthFn OTP policy hook", () => {
  it("fails closed when policy dependencies are absent", async () => {
    const hook = createOtpPolicyHook({});
    await expect(hook({ request }, { email: "a@example.test" })).rejects.toBeInstanceOf(
      AuthFnConfigError,
    );
  });

  it("checks Turnstile before rate limits", async () => {
    const consume = vi.fn();
    const hook = createOtpPolicyHook({
      turnstile: {
        verify: () => Promise.resolve({ success: false, reason: "invalid" }),
      },
      rateLimiter: { consume },
    });
    await expect(
      hook(
        { request },
        { email: "a@example.test", metadata: { turnstileToken: "bad" } },
      ),
    ).rejects.toBeInstanceOf(AuthFnRateLimitedError);
    expect(consume).not.toHaveBeenCalled();
  });

  it("reports Turnstile outages as retryable delivery failures", async () => {
    const hook = createOtpPolicyHook({
      turnstile: {
        verify: () => Promise.resolve({ success: false, reason: "unavailable" }),
      },
      rateLimiter: { consume: vi.fn() },
    });

    await expect(
      hook(
        { request },
        { email: "a@example.test", metadata: { turnstileToken: "token" } },
      ),
    ).rejects.toMatchObject({
      code: "AUTHFN_DELIVERY_FAILED",
      status: 503,
      retryable: true,
    } satisfies Partial<AuthFnDeliveryFailedError>);
  });

  it("uses fresh server-generated idempotency keys for Turnstile", async () => {
    const verify = vi.fn(() => Promise.resolve({ success: true as const }));
    const hook = createOtpPolicyHook({
      turnstile: { verify },
      rateLimiter: {
        consume: () =>
          Promise.resolve({ allowed: true, remaining: 4, retryAfterSeconds: 900 }),
      },
    });
    const value = {
      email: "a@example.test",
      metadata: { turnstileToken: "secret" },
    };

    await hook({ request }, value);
    await hook({ request }, value);

    const keys = verify.mock.calls.map(([input]) => input.idempotencyKey);
    expect(keys[0]).toMatch(/^turnstile_/u);
    expect(keys[1]).toMatch(/^turnstile_/u);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys).not.toContain("req_test");
  });

  it("removes transient Turnstile evidence before persistence", async () => {
    const hook = createOtpPolicyHook({
      turnstile: { verify: () => Promise.resolve({ success: true }) },
      rateLimiter: {
        consume: () =>
          Promise.resolve({ allowed: true, remaining: 4, retryAfterSeconds: 900 }),
      },
    });
    await expect(
      hook(
        { request },
        {
          email: "a@example.test",
          metadata: { turnstileToken: "secret", campaign: "signin" },
        },
      ),
    ).resolves.toMatchObject({ metadata: { campaign: "signin" } });
  });
});
