import { afterEach, describe, expect, it, vi } from "vitest";
import { apiRequest, SkillplaneApiError } from "../../src/lib/api/client.js";
import {
  ConnectedApps,
  OAUTH_CONNECTIONS_PATH,
  type ConnectionsRequest,
  type OAuthConnection,
} from "../../src/lib/oauth-connections/connections.svelte.js";

function connection(id: string, name = `Client ${id}`): OAuthConnection {
  return {
    consentId: `ocn_${id}`,
    clientId: `spclient_${id}`,
    clientName: name,
    resource: "https://mcp.skillplane.dev/mcp",
    scopes: ["skills:read"],
    grantedAt: "2026-11-13T10:00:00.000Z",
    lastTokenIssuedAt: null,
  };
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

/** A request stub whose calls settle only when a test says so. */
function controlledRequest() {
  const calls: { path: string; init?: RequestInit; settle: Deferred<unknown> }[] = [];
  const request = ((path: string, init?: RequestInit) => {
    const settle = deferred<unknown>();
    calls.push({ path, init, settle });
    return settle.promise;
  }) as ConnectionsRequest;
  return { calls, request };
}

function apiError(status: number, message = "The request failed"): SkillplaneApiError {
  return new SkillplaneApiError(status, {
    code: status === 404 ? "NOT_FOUND" : "INTERNAL_ERROR",
    message,
    requestId: "req_test",
  });
}

async function loaded(entries: OAuthConnection[]) {
  const { calls, request } = controlledRequest();
  const apps = new ConnectedApps(request);
  const loading = apps.load();
  calls[0]?.settle.resolve({ connections: entries });
  await loading;
  return { apps, calls };
}

const ids = (apps: ConnectedApps) => apps.visible.map((entry) => entry.consentId);

describe("ConnectedApps", () => {
  it("lists the user's connections from the SKI-46 endpoint", async () => {
    const { apps, calls } = await loaded([connection("a"), connection("b")]);
    expect(calls[0]?.path).toBe(OAUTH_CONNECTIONS_PATH);
    expect(apps.status).toBe("ready");
    expect(ids(apps)).toEqual(["ocn_a", "ocn_b"]);
  });

  it("reports an empty list as ready with no rows", async () => {
    const { apps } = await loaded([]);
    expect(apps.status).toBe("ready");
    expect(apps.visible).toEqual([]);
  });

  it("reports a failed load with the API message and recovers on retry", async () => {
    const { calls, request } = controlledRequest();
    const apps = new ConnectedApps(request);
    const first = apps.load();
    calls[0]?.settle.reject(
      apiError(403, "OAuth connections require a signed-in browser session"),
    );
    await first;
    expect(apps.status).toBe("error");
    expect(apps.loadError).toBe(
      "OAuth connections require a signed-in browser session",
    );

    const retry = apps.load();
    expect(apps.status).toBe("loading");
    calls[1]?.settle.resolve({ connections: [connection("a")] });
    await retry;
    expect(apps.status).toBe("ready");
    expect(apps.loadError).toBeNull();
    expect(ids(apps)).toEqual(["ocn_a"]);
  });

  it("ignores a load that finishes after a newer one", async () => {
    const { calls, request } = controlledRequest();
    const apps = new ConnectedApps(request);
    const stale = apps.load();
    const fresh = apps.load();
    calls[1]?.settle.resolve({ connections: [connection("fresh")] });
    await fresh;
    calls[0]?.settle.resolve({ connections: [connection("stale")] });
    await stale;
    expect(ids(apps)).toEqual(["ocn_fresh"]);
  });

  it("hides the row at once and drops it after the API confirms", async () => {
    const { apps, calls } = await loaded([connection("a", "Claude"), connection("b")]);
    const revoking = apps.revoke("ocn_a");
    // Hidden before the request settles, so the page can move focus now.
    expect(ids(apps)).toEqual(["ocn_b"]);
    expect(apps.isRemoving("ocn_a")).toBe(true);
    expect(calls[1]?.path).toBe(`${OAUTH_CONNECTIONS_PATH}/ocn_a`);
    expect(calls[1]?.init?.method).toBe("DELETE");

    calls[1]?.settle.resolve(undefined);
    await expect(revoking).resolves.toBe("revoked");
    expect(apps.connections.map((entry) => entry.consentId)).toEqual(["ocn_b"]);
    expect(apps.isRemoving("ocn_a")).toBe(false);
    expect(apps.announcement).toBe("Revoked access for Claude.");
    expect(apps.revokeError).toBeNull();
  });

  it("restores a failed revoke in its original position and explains why", async () => {
    const { apps, calls } = await loaded([
      connection("a"),
      connection("b", "Codex"),
      connection("c"),
    ]);
    const revoking = apps.revoke("ocn_b");
    expect(ids(apps)).toEqual(["ocn_a", "ocn_c"]);
    calls[1]?.settle.reject(apiError(500, "Skillplane could not complete the request"));
    await expect(revoking).resolves.toBe("failed");
    expect(ids(apps)).toEqual(["ocn_a", "ocn_b", "ocn_c"]);
    expect(apps.revokeError).toBe(
      "Codex is still connected. Skillplane could not complete the request",
    );
    expect(apps.announcement).toBe("");
  });

  it("restores the row when the network fails", async () => {
    const { apps, calls } = await loaded([connection("a", "Claude")]);
    const revoking = apps.revoke("ocn_a");
    calls[1]?.settle.reject(new TypeError("fetch failed"));
    await expect(revoking).resolves.toBe("failed");
    expect(ids(apps)).toEqual(["ocn_a"]);
    expect(apps.revokeError).toBe(
      "Claude is still connected. The connection could not be revoked.",
    );
  });

  it("treats 404 as already gone rather than restoring the row", async () => {
    const { apps, calls } = await loaded([connection("a")]);
    const revoking = apps.revoke("ocn_a");
    calls[1]?.settle.reject(apiError(404, "The OAuth connection was not found"));
    await expect(revoking).resolves.toBe("revoked");
    expect(apps.visible).toEqual([]);
    expect(apps.revokeError).toBeNull();
  });

  it("sends one request for a repeated revoke and ignores unknown IDs", async () => {
    const { apps, calls } = await loaded([connection("a")]);
    const first = apps.revoke("ocn_a");
    await expect(apps.revoke("ocn_a")).resolves.toBe("ignored");
    await expect(apps.revoke("ocn_missing")).resolves.toBe("ignored");
    expect(calls).toHaveLength(2);
    calls[1]?.settle.resolve(undefined);
    await expect(first).resolves.toBe("revoked");
  });

  it("keeps independent revokes independent when one fails", async () => {
    const { apps, calls } = await loaded([
      connection("a"),
      connection("b"),
      connection("c"),
    ]);
    const revokeA = apps.revoke("ocn_a");
    const revokeC = apps.revoke("ocn_c");
    expect(ids(apps)).toEqual(["ocn_b"]);
    calls[2]?.settle.resolve(undefined);
    await revokeC;
    calls[1]?.settle.reject(apiError(500));
    await revokeA;
    expect(ids(apps)).toEqual(["ocn_a", "ocn_b"]);
  });

  it("encodes the consent ID in the revoke path", async () => {
    const { apps, calls } = await loaded([
      { ...connection("x"), consentId: "ocn_a/b?c" },
    ]);
    void apps.revoke("ocn_a/b?c");
    expect(calls[1]?.path).toBe(`${OAUTH_CONNECTIONS_PATH}/ocn_a%2Fb%3Fc`);
  });
});

describe("apiRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves a 204 revoke without parsing a body and sends the CSRF header", async () => {
    const fetchMock = vi.fn<typeof fetch>(() =>
      Promise.resolve(new Response(null, { status: 204 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("document", { cookie: "skillplane.csrf=csrf%2Fvalue" });

    await expect(
      apiRequest(`${OAUTH_CONNECTIONS_PATH}/ocn_a`, { method: "DELETE" }),
    ).resolves.toBeUndefined();
    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("x-authfn-csrf")).toBe("csrf/value");
  });

  it("still rejects a non-JSON error body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(() =>
        Promise.resolve(new Response("upstream failure", { status: 502 })),
      ),
    );
    await expect(apiRequest(OAUTH_CONNECTIONS_PATH)).rejects.toMatchObject({
      status: 502,
      code: "REQUEST_FAILED",
    });
  });
});
