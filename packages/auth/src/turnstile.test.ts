import { describe, expect, it } from "vitest";
import { CloudflareTurnstileVerifier } from "./turnstile.js";

describe("CloudflareTurnstileVerifier", () => {
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
        idempotencyKey: "req_1",
      }),
    ).resolves.toEqual({ success: true, reason: "verified" });
    expect(JSON.parse(requestBody)).toMatchObject({
      secret: "turnstile-secret-at-least-32-characters",
      response: "turnstile-token",
      remoteip: "203.0.113.4",
      idempotency_key: "req_1",
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
