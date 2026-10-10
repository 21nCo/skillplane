import { afterEach, describe, expect, it, vi } from "vitest";
import { CloudflareTurnstileVerifier } from "./turnstile.js";

describe("CloudflareTurnstileVerifier", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("binds the Worker global fetch receiver", async () => {
    const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(function (
      this: unknown,
    ) {
      expect(this).toBe(globalThis);
      return Promise.resolve(
        Response.json({
          success: true,
          action: "otp_send",
          hostname: "app.skillplane.dev",
        }),
      );
    });
    const verifier = new CloudflareTurnstileVerifier({
      secretKey: "turnstile-secret-at-least-32-characters",
      expectedAction: "otp_send",
      allowedHostnames: ["app.skillplane.dev"],
    });

    await expect(verifier.verify({ token: "turnstile-token" })).resolves.toEqual({
      success: true,
      reason: "verified",
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("validates token, action, and hostname server-side", async () => {
    let requestBody = "";
    const verifier = new CloudflareTurnstileVerifier({
      secretKey: "turnstile-secret-at-least-32-characters",
      expectedAction: "otp_send",
      allowedHostnames: ["app.skillplane.dev"],
      fetcher: async (_input, init) => {
        requestBody = String(init?.body);
        return Response.json({
          success: true,
          action: "otp_send",
          hostname: "app.skillplane.dev",
        });
      },
    });
    await expect(
      verifier.verify({
        token: "turnstile-token",
        remoteIp: "203.0.113.4",
        idempotencyKey: "req_550e8400-e29b-41d4-a716-446655440000",
      }),
    ).resolves.toEqual({ success: true, reason: "verified" });
    expect(JSON.parse(requestBody)).toMatchObject({
      secret: "turnstile-secret-at-least-32-characters",
      response: "turnstile-token",
      remoteip: "203.0.113.4",
      idempotency_key: "550e8400-e29b-41d4-a716-446655440000",
    });
  });

  it("accepts Cloudflare's official testing-key response only when enabled", async () => {
    const response = () =>
      Promise.resolve(
        Response.json({
          success: true,
          hostname: "example.com",
          metadata: { result_with_testing_key: true },
        }),
      );
    const strict = new CloudflareTurnstileVerifier({
      secretKey: "turnstile-secret-at-least-32-characters",
      expectedAction: "otp_send",
      allowedHostnames: ["localhost"],
      fetcher: response,
    });
    const local = new CloudflareTurnstileVerifier({
      secretKey: "turnstile-secret-at-least-32-characters",
      expectedAction: "otp_send",
      allowedHostnames: ["localhost"],
      allowTestingKeyResponse: true,
      fetcher: response,
    });

    await expect(strict.verify({ token: "XXXX.DUMMY.TOKEN.XXXX" })).resolves.toEqual({
      success: false,
      reason: "invalid",
    });
    await expect(local.verify({ token: "XXXX.DUMMY.TOKEN.XXXX" })).resolves.toEqual({
      success: true,
      reason: "verified",
    });
  });

  it("fails closed on replay, action mismatch, or provider outage", async () => {
    const mismatch = new CloudflareTurnstileVerifier({
      secretKey: "turnstile-secret-at-least-32-characters",
      expectedAction: "otp_send",
      allowedHostnames: ["app.skillplane.dev"],
      fetcher: () =>
        Promise.resolve(
          Response.json({
            success: true,
            action: "other",
            hostname: "app.skillplane.dev",
          }),
        ),
    });
    await expect(mismatch.verify({ token: "replayed-token" })).resolves.toEqual({
      success: false,
      reason: "invalid",
    });

    const unavailable = new CloudflareTurnstileVerifier({
      secretKey: "turnstile-secret-at-least-32-characters",
      expectedAction: "otp_send",
      allowedHostnames: ["app.skillplane.dev"],
      fetcher: () => Promise.reject(new Error("network body and token")),
    });
    await expect(unavailable.verify({ token: "secret-token" })).resolves.toEqual({
      success: false,
      reason: "unavailable",
    });
  });
});
