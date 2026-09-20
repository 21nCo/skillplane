import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("$env/dynamic/public", () => ({
  env: { PUBLIC_DATAFN_DIRECT_ENABLED: "true" },
}));

import { resetWorkspaceDatafnClients } from "../../src/lib/datafn/client.js";
import { listSkills } from "../../src/lib/skills/api.js";

const appOrigin = "https://app-dev.skillplane.dev";
const workspaceId = "workspace:one";

afterEach(async () => {
  await resetWorkspaceDatafnClients();
  vi.unstubAllGlobals();
});

describe("first-party regional DataFn read boundary", () => {
  it("bootstraps once, omits cookies regionally, and renews after a placement mismatch", async () => {
    vi.stubGlobal("window", { location: { origin: appOrigin } });
    vi.stubGlobal("document", { cookie: "skillplane.csrf=csrf-token" });
    let bootstrapCount = 0;
    let oldRegionReads = 0;
    const requests: {
      url: string;
      credentials: RequestCredentials | undefined;
      headers: Headers;
    }[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), appOrigin);
      const headers = new Headers(init?.headers);
      requests.push({ url: url.href, credentials: init?.credentials, headers });
      if (url.pathname === "/api/v1/datafn/route") {
        bootstrapCount++;
        const now = Date.now();
        return Response.json({
          version: 1,
          httpUrl:
            bootstrapCount === 1
              ? "https://datafn-in-south-dev.skillplane.dev/datafn"
              : "https://datafn-us-east-dev.skillplane.dev/datafn",
          ticket: `ticket.${bootstrapCount}.signature`,
          expiresAt: now + 60_000,
          renewAfter: now + 45_000,
        });
      }
      if (url.hostname === "datafn-in-south-dev.skillplane.dev") {
        oldRegionReads++;
        if (oldRegionReads === 3) {
          return Response.json(
            {
              ok: false,
              error: {
                code: "DATAFN_REGION_MISMATCH",
                message: "Workspace moved",
                details: { executionStarted: false },
              },
            },
            { status: 409 },
          );
        }
      }
      return Response.json({ ok: true, result: { data: [], nextCursor: null } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await listSkills({ workspaceId });
    await listSkills({ workspaceId });
    expect(bootstrapCount).toBe(1);
    expect(oldRegionReads).toBe(2);
    expect(
      requests.filter((request) => request.url.includes("datafn-in-south")),
    ).toHaveLength(2);
    expect(requests[0]?.credentials).toBe("include");
    expect(requests[0]?.headers.get("x-authfn-csrf")).toBe("csrf-token");
    for (const request of requests.slice(1)) {
      expect(request.credentials).toBe("omit");
      expect(request.headers.get("cookie")).toBeNull();
      expect(request.headers.get("x-datafn-route-ticket")).toBe("ticket.1.signature");
    }

    await listSkills({ workspaceId });
    expect(bootstrapCount).toBe(2);
    expect(requests.at(-1)?.url).toContain(
      "datafn-us-east-dev.skillplane.dev/datafn/query",
    );
    expect(requests.at(-1)?.headers.get("x-datafn-route-ticket")).toBe(
      "ticket.2.signature",
    );
  });

  it("falls back to canonical reads when the rollout flag is withdrawn", async () => {
    vi.stubGlobal("window", { location: { origin: appOrigin } });
    vi.stubGlobal("document", { cookie: "skillplane.csrf=csrf-token" });
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (input) => {
        const url = new URL(String(input), appOrigin);
        requests.push(url.pathname);
        if (url.pathname === "/api/v1/datafn/route") {
          return new Response(null, { status: 404 });
        }
        return Response.json({ ok: true, result: { data: [], nextCursor: null } });
      }),
    );
    await listSkills({ workspaceId });
    await listSkills({ workspaceId });
    expect(requests).toEqual([
      "/api/v1/datafn/route",
      "/datafn/query",
      "/datafn/query",
    ]);
  });
});
