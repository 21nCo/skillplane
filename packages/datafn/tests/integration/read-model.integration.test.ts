import { authfn } from "authfn";
import {
  createDatabaseClient,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSkillplaneDatafnServer } from "../../src/server.js";

let databaseUrl: string;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let close: () => Promise<void>;
let handle: (request: Request) => Promise<Response>;

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  await purgeTenantFixture(databaseUrl, "datafn-a");
  await purgeTenantFixture(databaseUrl, "datafn-b");
  tenantA = await seedTenantFixture(databaseUrl, "datafn-a");
  tenantB = await seedTenantFixture(databaseUrl, "datafn-b");
  const database = createDatabaseClient({ connectionString: databaseUrl });
  const auth = authfn({
    plugins: [],
    namespace: "authfn",
    basePath: "/auth",
  }).createServer({ database: database.adapter });
  const server = await createSkillplaneDatafnServer({
    database,
    auth: auth.provider,
  });
  handle = (request) => server.router.handle(request);
  close = async () => {
    await server.close();
    await database.close();
  };
});

afterAll(async () => {
  if (close) await close();
  await purgeTenantFixture(databaseUrl, "datafn-a");
  await purgeTenantFixture(databaseUrl, "datafn-b");
});

function request(tenant: TenantFixture, path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${tenant.sessionToken}`,
      "content-type": "application/json",
      "x-skillplane-workspace-id": tenant.workspaceId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

describe("DataFn tenant read model", () => {
  it("returns only rows from the authenticated workspace", async () => {
    const response = await handle(
      request(tenantA, "/datafn/query", {
        resource: "skills",
        version: 1,
        select: ["id", "name", "description"],
        limit: 20,
      }),
    );
    expect(response.status).toBe(200);
    const serialized = JSON.stringify(await response.json());
    expect(serialized).toContain(tenantA.skillId);
    expect(serialized).not.toContain(tenantB.skillId);
  });

  it("denies generic mutations and secret-bearing resources", async () => {
    const mutation = await handle(
      request(tenantA, "/datafn/mutation", {
        resource: "skills",
        version: 1,
        operation: "merge",
        data: { id: tenantA.skillId, name: "Bypass" },
      }),
    );
    expect(mutation.status).toBe(403);

    const secret = await handle(
      request(tenantA, "/datafn/query", {
        resource: "authfnSessions",
        version: 1,
        select: ["id"],
      }),
    );
    expect([400, 403]).toContain(secret.status);
    expect(JSON.stringify(await secret.json())).not.toContain("tokenHash");
  });
});
