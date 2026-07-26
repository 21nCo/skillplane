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
let owner: TenantFixture;
let editor: TenantFixture;
let viewer: TenantFixture;
let outsider: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const suffix = `contexts-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const editorSuffix = `${suffix}-editor`;
const viewerSuffix = `${suffix}-viewer`;
const outsiderSuffix = `${suffix}-outsider`;

function headers(
  tenant: TenantFixture,
  workspaceId = owner.workspaceId,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": workspaceId,
    "content-type": "application/json",
    ...extra,
  };
}

async function data<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as { readonly data: T };
  return envelope.data;
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, suffix);
  editor = await seedTenantFixture(databaseUrl, editorSuffix);
  viewer = await seedTenantFixture(databaseUrl, viewerSuffix);
  outsider = await seedTenantFixture(databaseUrl, outsiderSuffix);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  await services.database.pool.query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, role)
     VALUES ($1, $2, $3, 'editor'), ($4, $2, $5, 'viewer')`,
    [
      `membership:${suffix}:editor`,
      owner.workspaceId,
      editor.userId,
      `membership:${suffix}:viewer`,
      viewer.userId,
    ],
  );
  app = createApiApp({
    requestId: () => `req_context_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, suffix);
  await purgeTenantFixture(databaseUrl, editorSuffix);
  await purgeTenantFixture(databaseUrl, viewerSuffix);
  await purgeTenantFixture(databaseUrl, outsiderSuffix);
});

describe("context knowledge and shared note API", () => {
  it("persists immutable, idempotent, conflict-safe context and note streams", async () => {
    const contextKey = `context-create-${suffix}`;
    const createBody = {
      slug: "btnextjs",
      name: "btnextjs",
      type: "repository",
      externalReference: "repo:btnextjs",
      description: "Project-specific review knowledge",
      metadata: { owner: "frontend-platform", protectedBranches: ["main"] },
      knowledge:
        "# btnextjs knowledge\n\nInspect live review threads before local diff conclusions.\n",
      learningMetadata: {
        summary: "Seed repository review knowledge",
        evidence: ["repository policy"],
      },
    };
    const create = await app.request(`/api/v1/skills/${owner.skillId}/contexts`, {
      method: "POST",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": contextKey,
      }),
      body: JSON.stringify(createBody),
    });
    expect(create.status).toBe(201);
    const created = await data<{
      context: {
        id: string;
        skillId: string;
        slug: string;
        type: string;
        externalReference: string;
        currentKnowledgeRevision: number;
      };
      knowledge: {
        id: string;
        revision: number;
        baseRevisionId: string | null;
        body: string;
        bodyDigest: string;
      };
    }>(create);
    expect(created.context).toMatchObject({
      skillId: owner.skillId,
      slug: "btnextjs",
      type: "repository",
      externalReference: "repo:btnextjs",
      currentKnowledgeRevision: 1,
    });
    expect(created.knowledge).toMatchObject({
      revision: 1,
      baseRevisionId: null,
      body: createBody.knowledge,
    });
    expect(created.knowledge.bodyDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);

    const replay = await app.request(`/api/v1/skills/${owner.skillId}/contexts`, {
      method: "POST",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": contextKey,
      }),
      body: JSON.stringify(createBody),
    });
    expect(replay.status).toBe(201);
    expect((await data<typeof created>(replay)).context.id).toBe(created.context.id);

    const reusedKey = await app.request(`/api/v1/skills/${owner.skillId}/contexts`, {
      method: "POST",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": contextKey,
      }),
      body: JSON.stringify({ ...createBody, name: "Different" }),
    });
    expect(reusedKey.status).toBe(409);
    expect(await reusedKey.text()).toContain("IDEMPOTENCY_KEY_REUSED");

    const duplicate = await app.request(`/api/v1/skills/${owner.skillId}/contexts`, {
      method: "POST",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": `context-duplicate-${suffix}`,
      }),
      body: JSON.stringify(createBody),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("CONTEXT_SLUG_CONFLICT");

    const active = await app.request(
      `/api/v1/skills/${owner.skillId}/contexts?state=active`,
      { headers: headers(viewer) },
    );
    expect(active.status).toBe(200);
    expect(
      (await data<{ contexts: readonly { id: string }[] }>(active)).contexts.map(
        (context) => context.id,
      ),
    ).toContain(created.context.id);

    const knowledge2 = await app.request(
      `/api/v1/contexts/${created.context.id}/knowledge`,
      {
        method: "PUT",
        headers: headers(editor, owner.workspaceId, {
          "idempotency-key": `knowledge-two-${suffix}`,
        }),
        body: JSON.stringify({
          expectedRevision: 1,
          knowledge:
            "# btnextjs knowledge\n\nInspect live review threads and verify direct navigation.\n",
          learningMetadata: {
            summary: "Add direct-navigation verification",
            confidence: "high",
          },
        }),
      },
    );
    expect(knowledge2.status).toBe(200);
    const secondKnowledge = (
      await data<{
        knowledge: {
          id: string;
          revision: number;
          baseRevisionId: string;
          body: string;
        };
      }>(knowledge2)
    ).knowledge;
    expect(secondKnowledge).toMatchObject({
      revision: 2,
      baseRevisionId: created.knowledge.id,
    });

    const history = await app.request(
      `/api/v1/contexts/${created.context.id}/knowledge/history`,
      { headers: headers(viewer) },
    );
    const knowledgeHistory = (
      await data<{
        revisions: readonly { id: string; revision: number; body: string }[];
      }>(history)
    ).revisions;
    expect(knowledgeHistory.map((revision) => revision.revision)).toEqual([2, 1]);
    expect(knowledgeHistory[1]?.body).toBe(createBody.knowledge);

    const concurrentKnowledge = await Promise.all(
      ["winner", "stale"].map((variant) =>
        app.request(`/api/v1/contexts/${created.context.id}/knowledge`, {
          method: "PUT",
          headers: headers(editor, owner.workspaceId, {
            "idempotency-key": `knowledge-concurrent-${variant}-${suffix}`,
          }),
          body: JSON.stringify({
            expectedRevision: 2,
            knowledge: `# btnextjs knowledge\n\nConcurrent ${variant} update.\n`,
            learningMetadata: { summary: `Concurrent ${variant}` },
          }),
        }),
      ),
    );
    expect(concurrentKnowledge.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const knowledgeConflict = concurrentKnowledge.find(
      (response) => response.status === 409,
    );
    expect(knowledgeConflict).toBeDefined();
    const knowledgeConflictBody = (await knowledgeConflict?.json()) as {
      readonly error: {
        readonly code: string;
        readonly details: { readonly currentRevision: number };
      };
    };
    expect(knowledgeConflictBody.error).toMatchObject({
      code: "CONTEXT_REVISION_CONFLICT",
      details: { currentRevision: 3 },
    });

    const createNoteBody = {
      title: "Review thread API",
      body: "# Review thread API\n\nRead unresolved review threads before conclusions.\n",
      learningMetadata: {
        summary: "Record review-thread source",
        externalReference: "api:reviewThreads",
      },
    };
    const noteCreate = await app.request(
      `/api/v1/contexts/${created.context.id}/notes`,
      {
        method: "POST",
        headers: headers(editor, owner.workspaceId, {
          "idempotency-key": `note-create-${suffix}`,
        }),
        body: JSON.stringify(createNoteBody),
      },
    );
    expect(noteCreate.status).toBe(201);
    const note = (
      await data<{
        note: {
          id: string;
          currentRevision: number;
          currentRevisionId: string;
          body: string;
        };
      }>(noteCreate)
    ).note;
    expect(note).toMatchObject({ currentRevision: 1, body: createNoteBody.body });

    for (const query of [
      {
        resource: "skillContexts",
        version: 1,
        select: [
          "id",
          "skillId",
          "slug",
          "contextType",
          "externalReference",
          "currentKnowledgeRevisionId",
        ],
        limit: 100,
      },
      {
        resource: "contextKnowledgeRevisions",
        version: 1,
        select: [
          "id",
          "contextId",
          "revision",
          "baseRevisionId",
          "bodyDigest",
          "learningMetadata",
        ],
        limit: 100,
      },
      {
        resource: "contextNotes",
        version: 1,
        select: ["id", "contextId", "noteKey", "title", "currentRevisionId"],
        limit: 100,
      },
    ]) {
      const response = await services.datafn.router.handle(
        new Request("http://localhost/datafn/query", {
          method: "POST",
          headers: headers(editor),
          body: JSON.stringify(query),
        }),
      );
      const serialized = await response.text();
      expect(response.status, `${query.resource}: ${serialized}`).toBe(200);
      expect(serialized).toContain(
        query.resource === "contextNotes" ? note.id : created.context.id,
      );
      expect(serialized).not.toContain(outsider.contextId);
    }

    const noteReplay = await app.request(
      `/api/v1/contexts/${created.context.id}/notes`,
      {
        method: "POST",
        headers: headers(editor, owner.workspaceId, {
          "idempotency-key": `note-create-${suffix}`,
        }),
        body: JSON.stringify(createNoteBody),
      },
    );
    expect((await data<{ note: { id: string } }>(noteReplay)).note.id).toBe(note.id);

    const noteUpdate = await app.request(`/api/v1/context-notes/${note.id}`, {
      method: "PUT",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": `note-update-${suffix}`,
      }),
      body: JSON.stringify({
        expectedRevision: 1,
        title: "Review thread API and cache",
        body: `${createNoteBody.body}\nInvalidate stale thread caches.\n`,
        learningMetadata: { summary: "Add cache invalidation" },
      }),
    });
    expect(noteUpdate.status).toBe(200);
    expect(
      (await data<{ note: { currentRevision: number } }>(noteUpdate)).note
        .currentRevision,
    ).toBe(2);

    const missingBase = await app.request(`/api/v1/context-notes/${note.id}`, {
      method: "PUT",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": `note-missing-base-${suffix}`,
      }),
      body: JSON.stringify({
        title: "Missing expected revision",
        body: "This must not be written.",
      }),
    });
    expect(missingBase.status).toBe(409);
    expect(await missingBase.text()).toContain("NOTE_REVISION_CONFLICT");

    const concurrentNotes = await Promise.all(
      ["winner", "stale"].map((variant) =>
        app.request(`/api/v1/context-notes/${note.id}`, {
          method: "PUT",
          headers: headers(editor, owner.workspaceId, {
            "idempotency-key": `note-concurrent-${variant}-${suffix}`,
          }),
          body: JSON.stringify({
            expectedRevision: 2,
            title: `Review thread ${variant}`,
            body: `# Review threads\n\n${variant} update.\n`,
            learningMetadata: { summary: `Concurrent ${variant}` },
          }),
        }),
      ),
    );
    expect(concurrentNotes.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    expect(
      await concurrentNotes.find((response) => response.status === 409)?.text(),
    ).toContain("NOTE_REVISION_CONFLICT");

    const noteHistory = await app.request(`/api/v1/context-notes/${note.id}/history`, {
      headers: headers(viewer),
    });
    const revisions = (
      await data<{
        revisions: readonly {
          revision: number;
          baseRevisionId: string | null;
          title: string;
          body: string;
        }[];
      }>(noteHistory)
    ).revisions;
    expect(revisions.map((revision) => revision.revision)).toEqual([3, 2, 1]);
    expect(revisions[2]).toMatchObject({
      revision: 1,
      baseRevisionId: null,
      title: createNoteBody.title,
      body: createNoteBody.body,
    });

    const viewerWrite = await app.request(
      `/api/v1/contexts/${created.context.id}/notes`,
      {
        method: "POST",
        headers: headers(viewer, owner.workspaceId, {
          "idempotency-key": `viewer-note-${suffix}`,
        }),
        body: JSON.stringify({
          title: "Forbidden",
          body: "A viewer cannot create this.",
        }),
      },
    );
    expect(viewerWrite.status).toBe(403);
    expect(await viewerWrite.text()).toContain("WORKSPACE_FORBIDDEN");

    const crossWorkspace = await app.request(`/api/v1/contexts/${created.context.id}`, {
      headers: headers(outsider, outsider.workspaceId),
    });
    expect(crossWorkspace.status).toBe(404);
    expect(await crossWorkspace.text()).not.toContain("btnextjs");

    const crossSkill = await app.request(
      `/api/v1/skills/${outsider.skillId}/contexts/by-slug/btnextjs`,
      { headers: headers(owner) },
    );
    expect(crossSkill.status).toBe(404);
    expect(await crossSkill.text()).not.toContain(created.context.id);

    const archiveNote = await app.request(`/api/v1/context-notes/${note.id}/archive`, {
      method: "POST",
      headers: headers(editor, owner.workspaceId, {
        "idempotency-key": `note-archive-${suffix}`,
      }),
    });
    expect(archiveNote.status).toBe(200);
    const defaultNotes = await app.request(
      `/api/v1/contexts/${created.context.id}/notes`,
      { headers: headers(viewer) },
    );
    expect(
      (await data<{ notes: readonly { id: string }[] }>(defaultNotes)).notes,
    ).toHaveLength(0);
    const archivedNotes = await app.request(
      `/api/v1/contexts/${created.context.id}/notes?state=archived`,
      { headers: headers(viewer) },
    );
    expect(
      (await data<{ notes: readonly { id: string }[] }>(archivedNotes)).notes.map(
        (entry) => entry.id,
      ),
    ).toEqual([note.id]);

    const archiveContext = await app.request(
      `/api/v1/contexts/${created.context.id}/archive`,
      {
        method: "POST",
        headers: headers(editor, owner.workspaceId, {
          "idempotency-key": `context-archive-${suffix}`,
        }),
      },
    );
    expect(archiveContext.status).toBe(200);
    const archivedContexts = await app.request(
      `/api/v1/skills/${owner.skillId}/contexts?state=archived`,
      { headers: headers(viewer) },
    );
    expect(
      (
        await data<{ contexts: readonly { id: string }[] }>(archivedContexts)
      ).contexts.map((entry) => entry.id),
    ).toContain(created.context.id);

    const restoreContext = await app.request(
      `/api/v1/contexts/${created.context.id}/restore`,
      {
        method: "POST",
        headers: headers(editor, owner.workspaceId, {
          "idempotency-key": `context-restore-${suffix}`,
        }),
      },
    );
    expect(restoreContext.status).toBe(200);
    const persisted = await app.request(
      `/api/v1/skills/${owner.skillId}/contexts/by-slug/btnextjs`,
      { headers: headers(viewer) },
    );
    expect(persisted.status).toBe(200);
    expect(
      (await data<{ context: { archivedAt: string | null } }>(persisted)).context
        .archivedAt,
    ).toBeNull();
  });
});
