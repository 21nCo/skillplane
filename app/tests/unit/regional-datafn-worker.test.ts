import { describe, expect, it, vi } from "vitest";
import regionalDatafn from "../../src/regional-datafn-worker.js";

const authority = "https://app-dev.skillplane.dev";
const regions = ["in-south", "us-east"] as const;
const topology = {
  public: { appAuthority: authority },
  cells: regions.map((regionId) => ({
    regionId,
    datafnEndpoint: {
      httpUrl: `https://datafn-${regionId}-dev.skillplane.dev/datafn`,
      audience: `skillplane-datafn-dev-${regionId}`,
    },
  })),
};

function fixture(regionId: (typeof regions)[number]) {
  const cell = vi.fn(async (request: Request) =>
    Response.json({ ok: true, path: new URL(request.url).pathname }),
  );
  const limit = vi.fn(async () => ({ success: true }));
  const env = {
    SKILLPLANE_TOPOLOGY: JSON.stringify(topology),
    SKILLPLANE_REGION_ID: regionId,
    DATAFN_DIRECT_ENABLED: "true",
    CELL_APP: { fetch: cell },
    DATAFN_EDGE_LIMIT: { limit },
  };
  const url = `https://datafn-${regionId}-dev.skillplane.dev/datafn/query`;
  return { env, url, cell, limit };
}

describe("public regional DataFn ingress", () => {
  it.each(regions)(
    "forwards only ticketed read traffic to the %s private cell",
    async (regionId) => {
      const { env, url, cell, limit } = fixture(regionId);
      const response = await regionalDatafn.fetch(
        new Request(url, {
          method: "POST",
          headers: {
            origin: authority,
            "cf-connecting-ip": "192.0.2.1",
            "content-type": "application/json",
            "x-datafn-route-ticket": "signed-ticket",
            "x-skillplane-workspace-id": "workspace:one",
          },
          body: JSON.stringify({ resource: "skills", version: 1 }),
        }),
        env,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe(authority);
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
      expect(cell).toHaveBeenCalledOnce();
      expect(cell.mock.calls[0]?.[0]).toMatchObject({ method: "POST" });
      const forwarded = cell.mock.calls[0]?.[0];
      expect(forwarded).toBeDefined();
      expect(forwarded && new URL(forwarded.url).pathname).toBe("/datafn/query");
      expect(limit).toHaveBeenCalledWith({ key: `${regionId}:192.0.2.1` });
    },
  );

  it("never exposes application paths or accepts cookies, bearer headers, or foreign origins", async () => {
    const { env, url, cell } = fixture("in-south");
    const headers = { origin: authority, "x-datafn-route-ticket": "signed-ticket" };
    for (const path of [
      "/api/v1/workspaces",
      "/auth/session",
      "/mcp",
      "/datafn/mutation",
    ]) {
      const response = await regionalDatafn.fetch(
        new Request(new URL(path, url), {
          method: "POST",
          headers,
        }),
        env,
      );
      expect(response.status).toBe(404);
    }
    for (const extra of [
      { cookie: "session=secret" },
      { authorization: "Bearer secret" },
      { origin: "https://evil.example" },
      { "x-datafn-routing-assertion": "assertion" },
    ]) {
      const requestHeaders = new Headers(headers);
      for (const [name, value] of Object.entries(extra))
        requestHeaders.set(name, value);
      const response = await regionalDatafn.fetch(
        new Request(url, {
          method: "POST",
          headers: requestHeaders,
        }),
        env,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
    }
    expect(cell).not.toHaveBeenCalled();
  });

  it("fails closed when disabled, rate limited, or addressed as the wrong region", async () => {
    const { env, url, cell } = fixture("in-south");
    const request = new Request(url, {
      method: "POST",
      headers: { origin: authority, "x-datafn-route-ticket": "signed-ticket" },
    });
    expect(
      (await regionalDatafn.fetch(request, { ...env, DATAFN_DIRECT_ENABLED: "false" }))
        .status,
    ).toBe(404);
    expect(
      (
        await regionalDatafn.fetch(request, {
          ...env,
          DATAFN_EDGE_LIMIT: { limit: async () => ({ success: false }) },
        })
      ).status,
    ).toBe(429);
    expect(
      (await regionalDatafn.fetch(request, { ...env, SKILLPLANE_REGION_ID: "us-east" }))
        .status,
    ).toBe(503);
    expect(cell).not.toHaveBeenCalled();
  });
});
