import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let databaseUrl: string;
let services: ApiServices;
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let editor: TenantFixture;
let admin: TenantFixture;
let viewer: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const names = {
  a: `context-security-a-${suffix}`,
  b: `context-security-b-${suffix}`,
  editor: `context-security-editor-${suffix}`,
  admin: `context-security-admin-${suffix}`,
  viewer: `context-security-viewer-${suffix}`,
};

function headers(
  tenant: TenantFixture,
  workspaceId: string,
  idempotencyKey?: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": workspaceId,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { readonly data: T }).data;
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  tenantA = await seedTenantFixture(databaseUrl, names.a);
  tenantB = await seedTenantFixture(databaseUrl, names.b);
  editor = await seedTenantFixture(databaseUrl, names.editor);
  admin = await seedTenantFixture(databaseUrl, names.admin);
  viewer = await seedTenantFixture(databaseUrl, names.viewer);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  await services.database.pool.query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, role)
     VALUES ($1, $2, $3, 'editor'),
            ($4, $2, $5, 'admin'),
            ($6, $2, $7, 'viewer')`,
    [
      `membership:${names.a}:editor`,
      tenantA.workspaceId,
      editor.userId,
      `membership:${names.a}:admin`,
      admin.userId,
      `membership:${names.a}:viewer`,
      viewer.userId,
    ],
  );
  app = createApiApp({
    requestId: () => `req_context_security_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  for (const name of Object.values(names)) {
    await purgeTenantFixture(databaseUrl, name);
  }
});

describe("context tenant and role isolation", () => {
  it("filters before reads and denies every viewer mutation without writes", async () => {
    const create = await app.request(`/api/v1/skills/${tenantA.skillId}/contexts`, {
      method: "POST",
      headers: headers(editor, tenantA.workspaceId, `create-${suffix}`),
      body: JSON.stringify({
        slug: "private-repository",
        name: "Private repository",
        type: "repository",
        externalReference: "repo:private/security",
        metadata: { classification: "private" },
        knowledge: "# Private knowledge\n\nNever leak this tenant marker.\n",
        learningMetadata: { summary: "Security fixture" },
      }),
    });
    expect(create.status).toBe(201);
    const created = await data<{
      context: { id: string };
      knowledge: { id: string; bodyDigest: string };
    }>(create);

    const noteCreate = await app.request(
      `/api/v1/contexts/${created.context.id}/notes`,
      {
        method: "POST",
        headers: headers(editor, tenantA.workspaceId, `note-${suffix}`),
        body: JSON.stringify({
          title: "Private security note",
          body: "# Private note\n\nTenant A only.",
          learningMetadata: { summary: "Isolation fixture" },
        }),
      },
    );
    expect(noteCreate.status).toBe(201);
    const note = await data<{ note: { id: string } }>(noteCreate);

    const adminUpdate = await app.request(`/api/v1/contexts/${created.context.id}`, {
      method: "PATCH",
      headers: headers(admin, tenantA.workspaceId, `admin-update-${suffix}`),
      body: JSON.stringify({
        description: "Updated by an authorized administrator",
      }),
    });
    expect(adminUpdate.status).toBe(200);

    const viewerRead = await app.request(
      `/api/v1/contexts/${created.context.id}/knowledge`,
      { headers: headers(viewer, tenantA.workspaceId) },
    );
    expect(viewerRead.status).toBe(200);

    const beforeCounts = await services.database.pool.query<{
      knowledge_count: string;
      note_count: string;
      note_revision_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM context_knowledge_revisions
           WHERE context_id = $1)::text AS knowledge_count,
         (SELECT count(*) FROM context_notes
           WHERE context_id = $1)::text AS note_count,
         (SELECT count(*) FROM context_note_revisions revision
            JOIN context_notes note ON note.id = revision.note_id
           WHERE note.context_id = $1)::text AS note_revision_count`,
      [created.context.id],
    );

    const viewerMutations = [
      app.request(`/api/v1/skills/${tenantA.skillId}/contexts`, {
        method: "POST",
        headers: headers(viewer, tenantA.workspaceId, `viewer-create-${suffix}`),
        body: JSON.stringify({
          slug: "forbidden",
          name: "Forbidden",
          type: "custom",
          knowledge: "Forbidden write",
        }),
      }),
      app.request(`/api/v1/contexts/${created.context.id}/knowledge`, {
        method: "PUT",
        headers: headers(viewer, tenantA.workspaceId, `viewer-knowledge-${suffix}`),
        body: JSON.stringify({
          expectedRevision: 1,
          knowledge: "Forbidden knowledge update",
        }),
      }),
      app.request(`/api/v1/contexts/${created.context.id}/notes`, {
        method: "POST",
        headers: headers(viewer, tenantA.workspaceId, `viewer-note-${suffix}`),
        body: JSON.stringify({ title: "Forbidden", body: "Forbidden note" }),
      }),
      app.request(`/api/v1/context-notes/${note.note.id}`, {
        method: "PUT",
        headers: headers(viewer, tenantA.workspaceId, `viewer-note-update-${suffix}`),
        body: JSON.stringify({
          expectedRevision: 1,
          title: "Forbidden update",
          body: "Forbidden body",
        }),
      }),
      app.request(`/api/v1/contexts/${created.context.id}/archive`, {
        method: "POST",
        headers: headers(viewer, tenantA.workspaceId, `viewer-archive-${suffix}`),
      }),
    ];
    const viewerResponses = await Promise.all(viewerMutations);
    expect(viewerResponses.map((response) => response.status)).toEqual([
      403, 403, 403, 403, 403,
    ]);
    for (const response of viewerResponses) {
      expect(await response.text()).toContain("WORKSPACE_FORBIDDEN");
    }

    const afterCounts = await services.database.pool.query<{
      knowledge_count: string;
      note_count: string;
      note_revision_count: string;
    }>(
      `SELECT
         (SELECT count(*) FROM context_knowledge_revisions
           WHERE context_id = $1)::text AS knowledge_count,
         (SELECT count(*) FROM context_notes
           WHERE context_id = $1)::text AS note_count,
         (SELECT count(*) FROM context_note_revisions revision
            JOIN context_notes note ON note.id = revision.note_id
           WHERE note.context_id = $1)::text AS note_revision_count`,
      [created.context.id],
    );
    expect(afterCounts.rows[0]).toEqual(beforeCounts.rows[0]);

    const tenantBReads = await Promise.all([
      app.request(`/api/v1/contexts/${created.context.id}`, {
        headers: headers(tenantB, tenantB.workspaceId),
      }),
      app.request(`/api/v1/contexts/${created.context.id}/knowledge`, {
        headers: headers(tenantB, tenantB.workspaceId),
      }),
      app.request(`/api/v1/contexts/${created.context.id}/knowledge/history`, {
        headers: headers(tenantB, tenantB.workspaceId),
      }),
      app.request(`/api/v1/contexts/${created.context.id}/notes`, {
        headers: headers(tenantB, tenantB.workspaceId),
      }),
      app.request(`/api/v1/context-notes/${note.note.id}`, {
        headers: headers(tenantB, tenantB.workspaceId),
      }),
      app.request(`/api/v1/context-notes/${note.note.id}/history`, {
        headers: headers(tenantB, tenantB.workspaceId),
      }),
      app.request(
        `/api/v1/skills/${tenantB.skillId}/contexts/by-slug/private-repository`,
        { headers: headers(tenantA, tenantA.workspaceId) },
      ),
    ]);
    expect(tenantBReads.map((response) => response.status)).toEqual([
      404, 404, 404, 404, 404, 404, 404,
    ]);
    for (const response of tenantBReads) {
      const serialized = await response.text();
      expect(serialized).not.toContain("Never leak this tenant marker");
      expect(serialized).not.toContain("Private security note");
      expect(serialized).not.toContain(created.knowledge.bodyDigest);
    }

    const archive = await app.request(
      `/api/v1/contexts/${created.context.id}/archive`,
      {
        method: "POST",
        headers: headers(tenantA, tenantA.workspaceId, `owner-archive-${suffix}`),
      },
    );
    expect(archive.status).toBe(200);
    const defaultList = await app.request(
      `/api/v1/skills/${tenantA.skillId}/contexts`,
      { headers: headers(viewer, tenantA.workspaceId) },
    );
    expect(await defaultList.text()).not.toContain(created.context.id);
    const restore = await app.request(
      `/api/v1/contexts/${created.context.id}/restore`,
      {
        method: "POST",
        headers: headers(tenantA, tenantA.workspaceId, `owner-restore-${suffix}`),
      },
    );
    expect(restore.status).toBe(200);
  });
});
