import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import {
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let databaseUrl: string;
let services: ApiServices;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let app: ReturnType<typeof createApiApp>;

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  await purgeTenantFixture(databaseUrl, "api-a");
  await purgeTenantFixture(databaseUrl, "api-b");
  tenantA = await seedTenantFixture(databaseUrl, "api-a");
  tenantB = await seedTenantFixture(databaseUrl, "api-b");
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  app = createApiApp({
    requestId: () => "req_api_integration",
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, "api-a");
  await purgeTenantFixture(databaseUrl, "api-b");
});

function authenticatedHeaders(
  tenant: TenantFixture,
  workspaceId = tenant.workspaceId,
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": workspaceId,
  };
}

describe("Hono API foundation", () => {
  it("mounts AuthFn and resolves a real bearer session", async () => {
    const response = await app.request("/auth/session", {
      headers: authenticatedHeaders(tenantA),
    });
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain(tenantA.userId);
    expect(serialized).not.toContain(tenantA.sessionToken);
  });

  it("lists only memberships owned by the authenticated user", async () => {
    const response = await app.request("/api/v1/workspaces", {
      headers: authenticatedHeaders(tenantA),
    });
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain(tenantA.workspaceId);
    expect(serialized).not.toContain(tenantB.workspaceId);
  });

  it("prefilters search by active workspace and nonleaking authorization", async () => {
    const search = await app.request("/api/v1/skills/search?q=review", {
      headers: authenticatedHeaders(tenantA),
    });
    expect(search.status).toBe(200);
    const serialized = JSON.stringify(await search.json());
    expect(serialized).toContain(tenantA.skillId);
    expect(serialized).not.toContain(tenantB.skillId);

    const crossWorkspace = await app.request("/api/v1/skills/search?q=review", {
      headers: authenticatedHeaders(tenantA, tenantB.workspaceId),
    });
    expect(crossWorkspace.status).toBe(404);
    const error = await crossWorkspace.json();
    expect(error).toMatchObject({
      ok: false,
      error: {
        code: "NOT_FOUND",
        requestId: "req_api_integration",
      },
    });
  });

  it("mounts the tenant-isolated DataFn query surface", async () => {
    const response = await app.request("/datafn/query", {
      method: "POST",
      headers: {
        ...authenticatedHeaders(tenantA),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        resource: "skills",
        version: 1,
        select: ["id", "name"],
        limit: 20,
      }),
    });
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain(tenantA.skillId);
    expect(serialized).not.toContain(tenantB.skillId);
  });

  it("rejects unauthenticated DataFn access before entering the DataFn router", async () => {
    const response = await app.request("/datafn/query", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: "skills",
        version: 1,
        select: ["id"],
        limit: 1,
      }),
    });

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      ok: false,
      error: {
        code: "AUTHENTICATION_REQUIRED",
        requestId: "req_api_integration",
      },
    });
  });
});
