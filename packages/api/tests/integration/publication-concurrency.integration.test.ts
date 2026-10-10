import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  createSkillBundleFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let services: ApiServices;
let tenant: TenantFixture;
let objectStorage: TestObjectStorage;
let app: ReturnType<typeof createApiApp>;
const suffix = `publish-${crypto.randomUUID().slice(0, 12)}`;

function headers(idempotencyKey: string): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": tenant.workspaceId,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

function encoded(bytes: Uint8Array, fields: Record<string, unknown> = {}): string {
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
});

afterAll(async () => {
  await services.datafn.close();
  await services.database.close();
});

describe("publication concurrency", () => {
  it("allows exactly one candidate based on the same release to publish", async () => {
    const initialBundle = await createSkillBundleFixture({
      name: "Concurrent review",
      slug: `concurrent-review-${suffix.split("-").at(-1)}`,
      skillMarkdown: "# Concurrent review\n\nInitial.\n",
    });
    const created = await app.request(
      `/api/v1/workspaces/${tenant.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers(`create-${suffix}`),
        body: encoded(initialBundle),
      },
    );
    expect(created.status).toBe(201);
    const initial = (await created.json()) as {
      data: { skill: { id: string }; version: { id: string } };
    };
    const skillId = initial.data.skill.id;
    const baseVersionId = initial.data.version.id;

    const failedCandidateBundle = await createSkillBundleFixture({
      name: "Concurrent review",
      slug: `concurrent-review-${suffix.split("-").at(-1)}`,
      skillMarkdown: "# Concurrent review\n\nFailed R2 reservation.\n",
    });
    objectStorage.failNextPut = true;
    const failedCandidate = await app.request(`/api/v1/skills/${skillId}/versions`, {
      method: "POST",
      headers: headers(`candidate-failed-${suffix}`),
      body: encoded(failedCandidateBundle, {
        baseVersionId,
        proposedBump: "patch",
        changeSummary: "R2 failure after revision reservation",
      }),
    });
    expect(failedCandidate.status).toBe(503);

    const candidates: string[] = [];
    for (const variant of ["one", "two"]) {
      const bundle = await createSkillBundleFixture({
        name: "Concurrent review",
        slug: `concurrent-review-${suffix.split("-").at(-1)}`,
        skillMarkdown: `# Concurrent review\n\nCandidate ${variant}.\n`,
      });
      const response = await app.request(`/api/v1/skills/${skillId}/versions`, {
        method: "POST",
        headers: headers(`candidate-${variant}-${suffix}`),
        body: encoded(bundle, {
          baseVersionId,
          proposedBump: "patch",
          changeSummary: `Candidate ${variant}`,
        }),
      });
      expect(response.status).toBe(201);
      const body = (await response.json()) as { data: { version: { id: string } } };
      candidates.push(body.data.version.id);
    }

    const responses = await Promise.all(
      candidates.map((candidateId, index) =>
        app.request(`/api/v1/skills/${skillId}/candidates/${candidateId}/approve`, {
          method: "POST",
          headers: headers(`publish-${String(index)}-${suffix}`),
        }),
      ),
    );
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);

    const versions = await services.database.pool.query<{
      id: string;
      revision: number;
      status: string;
      semantic_version: string | null;
    }>(
      `SELECT id, revision, status, semantic_version
         FROM skill_versions
        WHERE skill_id = $1
        ORDER BY revision`,
      [skillId],
    );
    expect(
      versions.rows.filter(
        (version) =>
          version.status === "published" && version.semantic_version === "1.0.1",
      ),
    ).toHaveLength(1);
    expect(
      versions.rows.filter((version) => version.status === "pending_review"),
    ).toHaveLength(1);
    expect(versions.rows.map((version) => version.revision)).toEqual([1, 3, 4]);
    const current = await services.database.pool.query<{
      current_published_version_id: string;
    }>("SELECT current_published_version_id FROM skills WHERE id = $1", [skillId]);
    expect(
      versions.rows.find(
        (version) => version.id === current.rows[0]?.current_published_version_id,
      )?.semantic_version,
    ).toBe("1.0.1");
    expect(objectStorage.inventory()).toHaveLength(3);

    const loser = versions.rows.find((version) => version.status === "pending_review");
    if (!loser) throw new Error("Expected the losing candidate to remain pending");
    const rejected = await app.request(
      `/api/v1/skills/${skillId}/candidates/${loser.id}/reject`,
      {
        method: "POST",
        headers: headers(`reject-${suffix}`),
        body: JSON.stringify({ reason: "Superseded by the concurrent winner" }),
      },
    );
    expect(rejected.status).toBe(200);
    const preserved = await services.database.pool.query<{
      status: string;
      change_summary: string;
    }>("SELECT status, change_summary FROM skill_versions WHERE id = $1", [loser.id]);
    expect(preserved.rows[0]).toMatchObject({
      status: "rejected",
      change_summary: expect.stringMatching(/^Candidate /u),
    });
    const audit = await services.database.pool.query<{
      reason: string;
    }>(
      `SELECT metadata->>'reason' AS reason
         FROM audit_events
        WHERE resource_id = $1 AND event_type = 'skill.version.rejected'`,
      [loser.id],
    );
    expect(audit.rows[0]?.reason).toBe("Superseded by the concurrent winner");
  });
});
