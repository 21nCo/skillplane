import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authfn = vi.hoisted(() => ({
  signOut: vi.fn(),
}));
const resetWorkspaceDatafnClients = vi.hoisted(() => vi.fn());

vi.mock("@authfn/client", () => ({
  createAuthFnClient: () => ({
    signOut: authfn.signOut,
  }),
}));
vi.mock("$lib/datafn/client.js", () => ({ resetWorkspaceDatafnClients }));

import { AuthClientError, signOut } from "../../src/lib/auth/client.js";

beforeEach(() => {
  authfn.signOut.mockReset();
  resetWorkspaceDatafnClients.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("authentication client cleanup", () => {
  it("preserves a successful sign-out when cached DataFn teardown fails", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    authfn.signOut.mockResolvedValue({ ok: true });
    resetWorkspaceDatafnClients.mockRejectedValue(new Error("teardown failed"));

    await expect(signOut()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith(
      JSON.stringify({ component: "app", event: "datafn.clients.reset.failed" }),
    );
  });

  it("preserves the authentication error when cleanup also fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    authfn.signOut.mockResolvedValue({
      ok: false,
      error: {
        code: "AUTHENTICATION_REQUIRED",
        message: "The session has expired",
        retryable: false,
      },
    });
    resetWorkspaceDatafnClients.mockRejectedValue(new Error("teardown failed"));

    await expect(signOut()).rejects.toBeInstanceOf(AuthClientError);
  });
});
