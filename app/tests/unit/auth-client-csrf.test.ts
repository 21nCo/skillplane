import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Exercises the real @authfn/client against a stubbed fetch. The browser can
// only see the readable CSRF cookie: the session cookie is HttpOnly and never
// appears in document.cookie.
const resetWorkspaceDatafnClients = vi.hoisted(() => vi.fn());
vi.mock("$lib/datafn/client.js", () => ({ resetWorkspaceDatafnClients }));

const fetchMock = vi.fn<typeof fetch>();

function signOutResponse(): Response {
  return new Response(
    JSON.stringify({
      ok: true,
      data: { revoked: true, allSessions: false },
      requestId: "req_sign_out",
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

async function loadClient() {
  return await import("../../src/lib/auth/client.js");
}

function sentHeaders(): Headers {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, init] = fetchMock.mock.calls[0] ?? [];
  expect(url).toBe("/auth/sign-out");
  expect(init?.method).toBe("POST");
  expect(init?.credentials).toBe("include");
  return new Headers(init?.headers);
}

beforeEach(() => {
  vi.resetModules();
  fetchMock.mockReset();
  fetchMock.mockImplementation(() => Promise.resolve(signOutResponse()));
  resetWorkspaceDatafnClients.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.doUnmock("@skillplane/auth/session");
  vi.unstubAllGlobals();
});

describe("browser AuthFn client CSRF", () => {
  it("sends the skillplane CSRF cookie on sign-out when the session cookie is HttpOnly", async () => {
    vi.stubGlobal("document", {
      cookie: "theme=dark; skillplane.csrf=csrf%20token%2Fvalue; other=x",
    });
    const { signOut } = await loadClient();

    await expect(signOut()).resolves.toBeUndefined();

    expect(sentHeaders().get("x-authfn-csrf")).toBe("csrf token/value");
    expect(resetWorkspaceDatafnClients).toHaveBeenCalledTimes(1);
  });

  it("does not fall back to AuthFn's default cookie name", async () => {
    vi.stubGlobal("document", { cookie: "authfn.csrf=wrong-prefix" });
    const { signOut } = await loadClient();

    await signOut();

    expect(sentHeaders().has("x-authfn-csrf")).toBe(false);
  });

  it("reads the CSRF cookie named by the shared auth cookie configuration", async () => {
    vi.doMock("@skillplane/auth/session", () => ({ AUTH_COOKIE_PREFIX: "tenant-b" }));
    vi.stubGlobal("document", {
      cookie: "skillplane.csrf=default-prefix; tenant-b.csrf=configured-prefix",
    });
    const { signOut } = await loadClient();

    await signOut();

    expect(sentHeaders().get("x-authfn-csrf")).toBe("configured-prefix");
  });
});
