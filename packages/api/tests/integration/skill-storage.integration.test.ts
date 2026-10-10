import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  createSkillBundleFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { sha256Hex } from "@skillplane/storage";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let services: ApiServices;
let tenant: TenantFixture;
let objectStorage: TestObjectStorage;
let app: ReturnType<typeof createApiApp>;
let skillId: string;
let versionId: string;
let bundle: Uint8Array;
const suffix = `skill-storage-${crypto.randomUUID().slice(0, 12)}`;

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": tenant.workspaceId,
    ...extra,
  };
}

function uploadBody(bytes: Uint8Array, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...fields,
    bundleBase64: Buffer.from(bytes).toString("base64"),
  });
}

beforeAll(async () => {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  tenant = await seedTenantFixture(databaseUrl, suffix);
  objectStorage = new TestObjectStorage();
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: objectStorage,
  });
  app = createApiApp({
    requestId: () => `req_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
  bundle = await createSkillBundleFixture({
    name: "Storage review",
    slug: `storage-review-${suffix.split("-").at(-1)}`,
    description: "Production storage integration fixture",
    tags: ["storage", "review"],
    skillMarkdown: "# Storage review\n\nVerify persisted files and digests.\n",
    files: { "references/checklist.md": "- R2\n- Postgres\n" },
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
});

describe("skill storage integration", () => {
  it("rejects invalid archives and R2 failures without a visible database record", async () => {
    const malformed = await app.request(
      `/api/v1/workspaces/${tenant.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers({
          "content-type": "application/zip",
          "idempotency-key": `malformed-${suffix}`,
        }),
        body: new Uint8Array([1, 2, 3]),
      },
    );
    expect(malformed.status).toBe(400);
    expect(objectStorage.inventory()).toHaveLength(0);

    objectStorage.failNextPut = true;
    const failed = await app.request(
      `/api/v1/workspaces/${tenant.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "idempotency-key": `r2-failure-${suffix}`,
        }),
        body: uploadBody(bundle),
      },
    );
    expect(failed.status).toBe(503);
    const persisted = await services.database.pool.query(
      "SELECT 1 FROM skills WHERE workspace_id = $1 AND slug LIKE 'storage-review-%'",
      [tenant.workspaceId],
    );
    expect(persisted.rowCount).toBe(0);
    expect(objectStorage.inventory()).toHaveLength(0);
  });

  it("creates an initial immutable version and replays the same idempotency key", async () => {
    const key = `create-${suffix}`;
    const request = () =>
      app.request(`/api/v1/workspaces/${tenant.workspaceId}/skills`, {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "idempotency-key": key,
        }),
        body: uploadBody(bundle, { visibility: "workspace" }),
      });
    const created = await request();
    expect(created.status, await created.clone().text()).toBe(201);
    const body = (await created.json()) as {
      data: {
        skill: { id: string; currentSemanticVersion: string };
        version: {
          id: string;
          semanticVersion: string;
          digest: string;
          objectKey?: string;
        };
      };
    };
    skillId = body.data.skill.id;
    versionId = body.data.version.id;
    expect(body.data.skill.currentSemanticVersion).toBe("1.0.0");
    expect(body.data.version.semanticVersion).toBe("1.0.0");
    expect(body.data.version.objectKey).toBeUndefined();
    expect(objectStorage.inventory()).toHaveLength(1);
    expect(objectStorage.inventory()[0]?.key).toMatch(
      new RegExp(
        `^workspaces/${tenant.workspaceId}/skills/${skillId}/bundles/sha256/[a-f0-9]{64}\\.zip$`,
        "u",
      ),
    );

    const replay = await request();
    expect(replay.status).toBe(201);
    const replayBody = (await replay.json()) as typeof body;
    expect(replayBody.data.skill.id).toBe(skillId);
    expect(replayBody.data.version.id).toBe(versionId);
    expect(objectStorage.inventory()).toHaveLength(1);

    const rows = await services.database.pool.query<{
      revisions: string;
      releases: string;
    }>(
      `SELECT count(*)::text AS revisions,
              count(*) FILTER (WHERE status = 'published')::text AS releases
         FROM skill_versions
        WHERE skill_id = $1`,
      [skillId],
    );
    expect(rows.rows[0]).toEqual({ revisions: "1", releases: "1" });
  });

  it("cleans the R2 upload when a duplicate workspace slug loses the database race", async () => {
    const duplicate = await app.request(
      `/api/v1/workspaces/${tenant.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers({
          "content-type": "application/json",
          "idempotency-key": `duplicate-${suffix}`,
        }),
        body: uploadBody(bundle),
      },
    );
    expect(duplicate.status).toBe(409);
    expect(await duplicate.text()).toContain("SKILL_SLUG_CONFLICT");
    const skills = await services.database.pool.query(
      "SELECT 1 FROM skills WHERE workspace_id = $1 AND slug LIKE 'storage-review-%'",
      [tenant.workspaceId],
    );
    expect(skills.rowCount).toBe(1);
    expect(objectStorage.inventory()).toHaveLength(1);
  });

  it("retrieves verified files and fails closed when R2 is unavailable", async () => {
    const response = await app.request(
      `/api/v1/skills/${skillId}/versions/${versionId}/files/references/checklist.md`,
      { headers: headers() },
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("- R2\n- Postgres\n");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("etag")).toMatch(/^"sha256-[a-f0-9]{64}"$/u);

    objectStorage.failReads = true;
    const unavailable = await app.request(
      `/api/v1/skills/${skillId}/versions/${versionId}/files/SKILL.md`,
      { headers: headers() },
    );
    objectStorage.failReads = false;
    expect(unavailable.status).toBe(503);
    expect(await unavailable.text()).toContain("R2_READ_FAILED");
  });

  it("archives and restores without mutating the release pointer", async () => {
    const before = await services.database.pool.query<{
      current_published_version_id: string;
    }>("SELECT current_published_version_id FROM skills WHERE id = $1", [skillId]);
    const archived = await app.request(`/api/v1/skills/${skillId}/archive`, {
      method: "POST",
      headers: headers({ "idempotency-key": `archive-${suffix}` }),
    });
    expect(archived.status).toBe(200);

    const defaultArchivedList = await app.request(
      `/api/v1/workspaces/${tenant.workspaceId}/skills`,
      { headers: headers() },
    );
    expect(await defaultArchivedList.text()).not.toContain(skillId);

    const historicalFile = await app.request(
      `/api/v1/skills/${skillId}/versions/${versionId}/files/SKILL.md`,
      { headers: headers() },
    );
    expect(historicalFile.status).toBe(200);

    const anonymous = await app.request(`/api/v1/skills/${skillId}`);
    expect(anonymous.status).toBe(404);

    const restored = await app.request(`/api/v1/skills/${skillId}/restore`, {
      method: "POST",
      headers: headers({ "idempotency-key": `restore-${suffix}` }),
    });
    expect(restored.status).toBe(200);
    const after = await services.database.pool.query<{
      current_published_version_id: string;
      archived_at: Date | null;
    }>("SELECT current_published_version_id, archived_at FROM skills WHERE id = $1", [
      skillId,
    ]);
    expect(after.rows[0]?.current_published_version_id).toBe(
      before.rows[0]?.current_published_version_id,
    );
    expect(after.rows[0]?.archived_at).toBeNull();
    const restoredList = await app.request(
      `/api/v1/workspaces/${tenant.workspaceId}/skills`,
      { headers: headers() },
    );
    expect(await restoredList.text()).toContain(skillId);
  });

  it("deletes an old orphan while preserving the referenced R2 object", async () => {
    const orphanBytes = new TextEncoder().encode("orphan");
    const orphanDigest = `sha256:${await sha256Hex(orphanBytes)}` as const;
    const orphan = await services.bundleStorage.putCanonicalBundle(
      tenant.workspaceId,
      `skill:orphan-${suffix}`,
      orphanDigest,
      orphanBytes,
    );
    const cleanup = await services.bundleStorage.cleanupOrphans({
      olderThan: new Date(Date.now() + 60_000),
      referencedKeys: async () => {
        const result = await services.database.pool.query<{ r2_object_key: string }>(
          "SELECT DISTINCT r2_object_key FROM skill_versions",
        );
        return new Set(result.rows.map((row) => row.r2_object_key));
      },
    });
    expect(cleanup.deleted).toEqual([orphan.key]);
    expect(cleanup.preserved).toContain(objectStorage.inventory()[0]?.key);
    expect(objectStorage.inventory()).toHaveLength(1);
  });
});
