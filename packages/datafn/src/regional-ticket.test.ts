import { generateKeyPairSync } from "node:crypto";
import { createDatafnHttpRouteProvider, DefaultHttpTransport } from "@datafn/client";
import {
  createDatafnEd25519RouteTicketSigner,
  createDatafnEd25519RouteTicketVerifier,
  createDatafnRouteBootstrap,
  createMemoryDatafnPlacementDirectory,
  claimDatafnNamespacePlacement,
  type DatafnRegionalTicketRuntime,
} from "@datafn/server";
import {
  createMemoryIndexedDirectoryStore,
  memoryAdapter,
} from "@superfunctions/db/adapters";
import type { DatabaseClient } from "@skillplane/db";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillplaneDatafnServer } from "./server.js";

const workspaceId = "workspace:regional-ticket";
const userId = "user:regional-ticket";
const appOrigin = "https://app.example";
const payload = { resource: "skills", version: 1, select: ["id"], limit: 10 };

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function database(): DatabaseClient {
  const pool = {
    query: async () => ({
      rows: [
        {
          id: "membership:one",
          role: "owner",
          workspace_id: workspaceId,
          user_id: userId,
          email: "user@example.test",
        },
      ],
    }),
  };
  return { adapter: memoryAdapter(), pool } as unknown as DatabaseClient;
}

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error("Expected regional test fixture");
  return value;
}

describe("Skillplane ticket-only DataFn cells", () => {
  it("uses one canonical bootstrap for regional reads and fences a moved workspace", async () => {
    const directory = createMemoryDatafnPlacementDirectory();
    await claimDatafnNamespacePlacement({
      directory,
      namespace: workspaceId,
      regionId: "in-south",
    });
    const keys = generateKeyPairSync("ed25519");
    const signer = createDatafnEd25519RouteTicketSigner({
      activeKeyId: "current",
      privateKey: keys.privateKey,
    });
    const verifier = createDatafnEd25519RouteTicketVerifier({
      publicKeys: { current: keys.publicKey },
    });
    const regions = new Map<
      string,
      Awaited<ReturnType<typeof createSkillplaneDatafnServer>>
    >();
    for (const regionId of ["in-south", "us-east"]) {
      const runtime: DatafnRegionalTicketRuntime = {
        verifier,
        issuer: appOrigin,
        audience: `skillplane-${regionId}`,
        allowedOrigins: [appOrigin],
      };
      const server = await createSkillplaneDatafnServer({
        database: database(),
        controlDatabase: database(),
        auth: { authenticate: async () => null },
        regionId,
        permissionDirectory: createMemoryIndexedDirectoryStore(),
        routeTickets: runtime,
        placement: { directory, routeTickets: runtime },
      });
      servers.push(server);
      regions.set(regionId, server);
    }
    const endpoints = Object.fromEntries(
      ["in-south", "us-east"].map((regionId) => [
        regionId,
        {
          httpUrl: `https://datafn-${regionId}.example/datafn`,
          audience: `skillplane-${regionId}`,
        },
      ]),
    );
    const bootstrap = createDatafnRouteBootstrap({
      directory,
      signer,
      issuer: appOrigin,
      authenticate: (request) => {
        if (request.headers.get("authorization") !== "Bearer user")
          throw new Error("unauthorized");
        return { subject: userId, namespace: workspaceId };
      },
      authorize: () => ["query", "search"],
      resolveEndpoint: (placement) => required(endpoints[placement.regionId]),
    });
    const calls: string[] = [];
    const routedFetch: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push(url.host + url.pathname);
      const headers = new Headers(init?.headers);
      if (url.origin !== appOrigin) headers.set("origin", appOrigin);
      const request = new Request(url, { ...init, headers });
      if (url.origin === appOrigin) return bootstrap(request);
      const regionId = url.host.slice("datafn-".length).replace(".example", "");
      return required(regions.get(regionId)).router.handle(request);
    };
    const provider = createDatafnHttpRouteProvider({
      bootstrapUrl: `${appOrigin}/api/v1/datafn/route`,
      fetch: routedFetch,
      headers: () => ({ authorization: "Bearer user" }),
    });
    const transport = new DefaultHttpTransport("/datafn", {
      routeProvider: provider,
      fetch: routedFetch,
      headers: { "x-skillplane-workspace-id": workspaceId },
      credentials: "omit",
    });
    try {
      expect(((await transport.query(payload)) as { ok: boolean }).ok).toBe(true);
      expect(((await transport.query(payload)) as { ok: boolean }).ok).toBe(true);
      expect(calls).toEqual([
        "app.example/api/v1/datafn/route",
        "datafn-in-south.example/datafn/query",
        "datafn-in-south.example/datafn/query",
      ]);
      const route = await required(transport.regionalRoutes).get();
      const body = JSON.stringify(payload);
      const forged = await required(regions.get("in-south")).router.handle(
        new Request("https://datafn-in-south.example/datafn/query", {
          method: "POST",
          headers: {
            "x-datafn-route-ticket": route.ticket + "forged",
            origin: appOrigin,
            "content-type": "application/json",
          },
          body,
        }),
      );
      expect(forged.status).toBe(401);
      const cookie = await required(regions.get("in-south")).router.handle(
        new Request("https://datafn-in-south.example/datafn/query", {
          method: "POST",
          headers: {
            "x-datafn-route-ticket": route.ticket,
            cookie: "session=opaque",
            origin: appOrigin,
            "content-type": "application/json",
          },
          body,
        }),
      );
      expect(cookie.status).toBe(403);
      const placement = required(await directory.get(workspaceId));
      await directory.compareAndSet({
        namespace: workspaceId,
        expectedEpoch: placement.epoch,
        next: { ...placement, epoch: placement.epoch + 1, state: "moving" },
      });
      const moved = await required(regions.get("in-south")).router.handle(
        new Request("https://datafn-in-south.example/datafn/query", {
          method: "POST",
          headers: {
            "x-datafn-route-ticket": route.ticket,
            origin: appOrigin,
            "content-type": "application/json",
          },
          body,
        }),
      );
      expect(moved.status).toBe(409);
      const moving = required(await directory.get(workspaceId));
      await directory.compareAndSet({
        namespace: workspaceId,
        expectedEpoch: moving.epoch,
        next: {
          ...moving,
          regionId: "us-east",
          epoch: moving.epoch + 1,
          state: "active",
        },
      });
      required(transport.regionalRoutes).invalidate();
      expect(((await transport.query(payload)) as { ok: boolean }).ok).toBe(true);
      expect(calls.at(-1)).toBe("datafn-us-east.example/datafn/query");
    } finally {
      transport.dispose();
    }
  });
});
