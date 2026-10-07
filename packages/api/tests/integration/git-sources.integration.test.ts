import { GitSourceService } from "@skillplane/domain";
import { canonicalizeBundle } from "@skillplane/storage";
import { createSkillBundleFixture } from "@skillplane/testing";
import type { Principal } from "@skillplane/domain";
import { beforeAll, afterAll, it, expect } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  seedTenantFixture,
  purgeTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
const makeSuffix = () => `source-http-${crypto.randomUUID()}`;
const fixtureSuffixes = [makeSuffix(), makeSuffix(), makeSuffix()] as const;
let databaseUrl: string;
let services: ApiServices,
  owner: TenantFixture,
  viewer: TenantFixture,
  outsider: TenantFixture,
  app: ReturnType<typeof createApiApp>;
beforeAll(async () => {
  const url = await resolveTestDatabaseUrl();
  databaseUrl = url;
  await migrateDatabase(url);
  owner = await seedTenantFixture(url, fixtureSuffixes[0]);
  viewer = await seedTenantFixture(url, fixtureSuffixes[1]);
  outsider = await seedTenantFixture(url, fixtureSuffixes[2]);
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
  for (const suffix of fixtureSuffixes) await purgeTenantFixture(databaseUrl, suffix);
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

it("repairs immediate skill/version routing on apply replay before projection processing", async () => {
  const principal: Principal = {
    kind: "user",
    role: "owner",
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    actorId: owner.userId,
    sessionId: "routing-test",
  };
  const mutation = { principal, requestId: crypto.randomUUID() };
  const bundle = await canonicalizeBundle(
    await createSkillBundleFixture({
      name: "Routing import",
      slug: `routing-${crypto.randomUUID()}`,
      description: "Source routing",
      tags: [],
      skillMarkdown: "# Routing import",
    }),
  );
  const sources = new GitSourceService(
    services.database.pool,
    services.skillService,
    services.skillVersionService,
    {
      snapshot: async () => ({
        commitSha: "a".repeat(40),
        skills: [{ path: "one", bundle, error: null }],
      }),
    },
  );
  const source = await sources.create({
    ...mutation,
    config: { repositoryUrl: "https://github.com/a/routing" },
    idempotencyKey: crypto.randomUUID(),
  });
  const preview = await sources.preview({ ...mutation, sourceId: source.id });
  const applied = await sources.apply({
    ...mutation,
    sourceId: source.id,
    runId: preview.id,
  });
  const result = applied.results[0];
  if (!result?.skillId || !result.versionId)
    throw new Error("Import did not create a routable version");
  await services.controlDatabase.pool.query(
    "DELETE FROM resource_routing_directory WHERE resource_id=ANY($1::text[])",
    [[result.skillId, result.versionId]],
  );
  const response = await app.request(
    `/api/v1/workspaces/${owner.workspaceId}/sources/${source.id}/apply`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${owner.sessionToken}`,
        "content-type": "application/json",
        "x-skillplane-workspace-id": owner.workspaceId,
      },
      body: JSON.stringify({ runId: preview.id }),
    },
  );
  expect(response.status).toBe(200);
  const routes = await services.controlDatabase.pool.query(
    "SELECT resource_type,resource_id FROM resource_routing_directory WHERE workspace_id=$1 AND resource_id=ANY($2::text[]) AND state='active'",
    [owner.workspaceId, [result.skillId, result.versionId]],
  );
  expect(routes.rows).toEqual(
    expect.arrayContaining([
      { resource_type: "skill", resource_id: result.skillId },
      { resource_type: "skill_version", resource_id: result.versionId },
    ]),
  );
});
