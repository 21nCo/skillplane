import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
let services: ApiServices, owner: TenantFixture, outsider: TenantFixture;
let app: ReturnType<typeof createApiApp>;
beforeAll(async () => {
  const url = await resolveTestDatabaseUrl();
  await migrateDatabase(url);
  owner = await seedTenantFixture(url, `groups-http-${crypto.randomUUID()}`);
  outsider = await seedTenantFixture(url, `groups-out-${crypto.randomUUID()}`);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: url,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  app = createApiApp({ getServices: async () => services });
});
afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
});
it("routes lifecycle and assignments through authenticated workspace scope", async () => {
  const headers = {
    authorization: `Bearer ${owner.sessionToken}`,
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-skillplane-workspace-id": owner.workspaceId,
  };
  const base = `/api/v1/workspaces/${owner.workspaceId}/groups`;
  expect((await app.request(base)).status).toBe(401);
  expect(
    (
      await app.request(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Design" }),
      })
    ).status,
  ).toBe(201);
  const list = await app.request(base, { headers });
  expect(list.status).toBe(200);
  const body = (await list.json()) as { data: { groups: { id: string }[] } };
  const id = body.data.groups[0]?.id ?? "";
  expect(id).toBeTruthy();
  expect(
    (
      await app.request(`${base}/${id}/skills/${owner.skillId}`, {
        method: "PUT",
        headers,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`${base}/${id}/members/${owner.userId}`, {
        method: "PUT",
        headers,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`${base}/${id}/skills/${outsider.skillId}`, {
        method: "PUT",
        headers,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(`${base}/${id}`, {
        headers: { authorization: `Bearer ${outsider.sessionToken}` },
      })
    ).status,
  ).toBe(404);
  const patch = await app.request(`${base}/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      name: "Design systems",
      description: "Reusable design work",
      archived: true,
      expectedRevision: 1,
    }),
  });
  expect(patch.status).toBe(200);
  const filtered = await app.request(
    `/api/v1/workspaces/${owner.workspaceId}/skills?groupId=${encodeURIComponent(id)}`,
    { headers },
  );
  expect(filtered.status).toBe(200);
  expect(
    ((await filtered.json()) as { data: { skills: unknown[] } }).data.skills,
  ).toEqual([]);
});
