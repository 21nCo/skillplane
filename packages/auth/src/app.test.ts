import type { AuthFnServer } from "authfn";
import { describe, expect, it, vi } from "vitest";
import { createAuthApplication } from "./app.js";

describe("auth application", () => {
  async function bridge(body: unknown, status = 400) {
    const authfn = {
      router: {
        match: () => true,
        handle: () => Promise.resolve(Response.json(body, { status })),
      },
    } as unknown as AuthFnServer;
    return createAuthApplication({ authfn }).request("/auth/otp/verify", {
      method: "POST",
    });
  }

  it("removes challenge details from valid OTP errors", async () => {
    const response = await bridge({
      ok: false,
      error: {
        code: "AUTHFN_OTP_INVALID",
        message: "Invalid code",
        retryable: false,
        details: { challengeId: "private-challenge" },
      },
      requestId: "req_test",
    });
    expect(await response.json()).toEqual({
      ok: false,
      error: {
        code: "AUTHFN_OTP_INVALID",
        message: "Invalid code",
        retryable: false,
      },
      requestId: "req_test",
    });
  });

  it.each([
    { message: undefined, retryable: false },
    { message: "Invalid code", retryable: undefined },
    { message: 42, retryable: false },
    { message: "Invalid code", retryable: "false" },
    { message: "Invalid code", retryable: false, details: [] },
  ])("leaves malformed upstream envelopes untouched: %j", async (fields) => {
    const body = {
      ok: false,
      error: { code: "AUTHFN_OTP_INVALID", details: { marker: true }, ...fields },
      requestId: "req_test",
    };
    const response = await bridge(body);
    expect(await response.json()).toEqual(JSON.parse(JSON.stringify(body)));
  });

  it("preserves rate-limit retry timing", async () => {
    const response = await bridge(
      {
        ok: false,
        error: {
          code: "AUTHFN_RATE_LIMITED",
          message: "Wait",
          retryable: true,
          details: { retryAfterSeconds: 2.5 },
        },
        requestId: "req_test",
      },
      429,
    );
    expect(response.headers.get("retry-after")).toBe("3");
  });

  it("delegates AuthFn routes without declaring local OTP handlers", async () => {
    const handle = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const authfn = { router: { handle, match: () => true } } as unknown as AuthFnServer;
    const app = createAuthApplication({ authfn });

    const response = await app.request("/auth/otp/send", { method: "POST" });

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });

  it("returns a private 404 without delegating unmatched routes", async () => {
    const handle = vi.fn();
    const match = vi.fn(() => null);
    const authfn = { router: { handle, match } } as unknown as AuthFnServer;
    const response = await createAuthApplication({ authfn }).request(
      "/auth/not-a-route",
      { headers: { "x-request-id": "req_missing" } },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-request-id")).toBe("req_missing");
    expect(await response.json()).toMatchObject({
      ok: false,
      error: { code: "ROUTE_NOT_FOUND", retryable: false },
      requestId: "req_missing",
    });
    expect(match).toHaveBeenCalledWith("GET", "/auth/not-a-route");
    expect(handle).not.toHaveBeenCalled();
  });
});
