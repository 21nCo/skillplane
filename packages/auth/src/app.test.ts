import type { AuthFnServer } from "authfn";
import { describe, expect, it, vi } from "vitest";
import { createAuthApplication } from "./app.js";

describe("auth application", () => {
  it("delegates AuthFn routes without declaring local OTP handlers", async () => {
    const handle = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    const authfn = { router: { handle } } as unknown as AuthFnServer;
    const app = createAuthApplication({ authfn });

    const response = await app.request("/auth/otp/send", { method: "POST" });

    expect(response.status).toBe(200);
    expect(handle).toHaveBeenCalledOnce();
    expect(handle.mock.calls[0]?.[0]).toBeInstanceOf(Request);
  });
});
