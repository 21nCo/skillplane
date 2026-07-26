import type { AuthFnInstance } from "@authfn/core";
import { describe, expect, it } from "vitest";
import { createAuthApplication } from "./app.js";

function testAuthFn() {
  return {
    router: {
      handle: () => Promise.resolve(Response.json({ ok: true })),
    },
  } as unknown as AuthFnInstance;
}

describe("auth application guards", () => {
  it("rejects risky OTP sends without Turnstile before delivery", async () => {
    let rateCalls = 0;
    const app = createAuthApplication({
      authfn: testAuthFn(),
      turnstile: {
        verify: () => Promise.resolve({ success: false, reason: "invalid" }),
      },
      rateLimiter: {
        consume() {
          rateCalls += 1;
          return Promise.resolve({
            allowed: true,
            remaining: 4,
            retryAfterSeconds: 900,
          });
        },
      },
    });
    const response = await app.request("/auth/otp/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "alice@example.test",
        turnstileToken: "",
      }),
    });
    expect(response.status).toBe(429);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "AUTH_RATE_LIMITED" },
    });
    expect(rateCalls).toBe(0);
  });
});
