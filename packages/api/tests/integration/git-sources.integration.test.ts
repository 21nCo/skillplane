import { beforeAll, afterAll, it, expect } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
let services: ApiServices,
  owner: TenantFixture,
  viewer: TenantFixture,
  outsider: TenantFixture,
  app: ReturnType<typeof createApiApp>;
beforeAll(async () => {
  const url = await resolveTestDatabaseUrl();
  await migrateDatabase(url);
  owner = await seedTenantFixture(url, `source-http-${crypto.randomUUID()}`);
  viewer = await seedTenantFixture(url, `source-viewer-${crypto.randomUUID()}`);
  outsider = await seedTenantFixture(url, `source-outside-${crypto.randomUUID()}`);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: url,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  await services.database.pool.query(
    "INSERT INTO workspace_memberships(id,workspace_id,user_id,role) VALUES($1,$2,$3,'viewer')",
    [`membership:${crypto.randomUUID()}`, owner.workspaceId, viewer.userId],
  );
  app = createApiApp({ getServices: async () => services });
});
afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
});
it("authenticates source configuration, isolates workspace bindings and denies viewer writes", async () => {
  const base = `/api/v1/workspaces/${owner.workspaceId}/sources`,
    headers = {
      authorization: `Bearer ${owner.sessionToken}`,
      "content-type": "application/json",
      "idempotency-key": crypto.randomUUID(),
      "x-skillplane-workspace-id": owner.workspaceId,
    };
  expect((await app.request(base)).status).toBe(401);
  const created = await app.request(base, {
    method: "POST",
    headers,
    body: JSON.stringify({ repositoryUrl: "https://github.com/a/b", ref: "main" }),
  });
  expect(created.status).toBe(201);
  const envelope = (await created.json()) as {
    data: { source: { id: string; revision: number } };
  };
  const { id, revision } = envelope.data.source;
  expect(
    (
      await app.request(base, {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${viewer.sessionToken}` },
        body: JSON.stringify({ repositoryUrl: "https://github.com/a/b" }),
      })
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(`${base}/${id}`, {
        headers: { authorization: `Bearer ${outsider.sessionToken}` },
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(`${base}/${id}/bindings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "review", skillId: outsider.skillId }),
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(`${base}/${id}/bindings`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: "review", skillId: owner.skillId }),
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`${base}/${id}/bindings`, {
        method: "DELETE",
        headers,
        body: JSON.stringify({ path: "review" }),
      })
    ).status,
  ).toBe(200);
  const archived = await app.request(`${base}/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      repositoryUrl: "https://github.com/a/b",
      ref: "main",
      archived: true,
      expectedRevision: revision + 2,
    }),
  });
  expect(archived.status).toBe(200);
  expect(
    (await app.request(`${base}/${id}/preview`, { method: "POST", headers })).status,
  ).toBe(409);
  expect(
    (await app.request(`${base}/${id}/apply`, { method: "POST", headers, body: "{}" }))
      .status,
  ).toBe(400);
});
