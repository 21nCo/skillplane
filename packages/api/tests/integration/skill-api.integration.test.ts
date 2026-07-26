import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  createSkillBundleFixture,
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

interface CreatedSkill {
  readonly skill: {
    readonly id: string;
    readonly slug: string;
    readonly visibility: string;
    readonly currentPublishedVersionId: string;
    readonly currentSemanticVersion: string;
    readonly archivedAt: string | null;
  };
  readonly version: {
    readonly id: string;
    readonly revision: number;
    readonly semanticVersion: string | null;
    readonly status: string;
    readonly digest: string;
  };
}

let databaseUrl: string;
let services: ApiServices;
let owner: TenantFixture;
let viewer: TenantFixture;
let storage: TestObjectStorage;
let app: ReturnType<typeof createApiApp>;
const suffix = `skill-api-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const viewerSuffix = `${suffix}-viewer`;
const skillSlug = `pull-request-review-${suffix.split("-").at(-1)}`;
const workspaceSlug = `workspace-${suffix}`;

function headers(
  tenant: TenantFixture,
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": owner.workspaceId,
    ...extra,
  };
}

function jsonUpload(bundle: Uint8Array, fields: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ...fields,
    bundleBase64: Buffer.from(bundle).toString("base64"),
  });
}

async function data<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as {
    readonly data: T;
  };
  return envelope.data;
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, suffix);
  viewer = await seedTenantFixture(databaseUrl, viewerSuffix);
  storage = new TestObjectStorage();
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: storage,
  });
  await services.database.pool.query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, role)
     VALUES ($1, $2, $3, 'viewer')`,
    [`membership:${suffix}:viewer`, owner.workspaceId, viewer.userId],
  );
  app = createApiApp({
    requestId: () => `req_skill_api_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, suffix);
  await purgeTenantFixture(databaseUrl, viewerSuffix);
});

describe("skill management API", () => {
  it("persists the complete create, discover, version, publish, and lifecycle workflow", async () => {
    const initialBundle = await createSkillBundleFixture({
      name: "Pull request review",
      slug: skillSlug,
      description: "Repeatable, evidence-backed pull request reviews",
      tags: ["pull-request", "review"],
      skillMarkdown:
        "# Pull request review\n\nInspect authorization and data boundaries before style.\n",
      files: {
        "references/checklist.md":
          "# Checklist\n\n- Confirm tenant scope\n- Verify persistence\n",
        "scripts/verify.sh": "#!/bin/sh\nexit 0\n",
      },
    });
    const create = await app.request(`/api/v1/workspaces/${owner.workspaceId}/skills`, {
      method: "POST",
      headers: headers(owner, {
        "content-type": "application/json",
        "idempotency-key": `create-${suffix}`,
      }),
      body: jsonUpload(initialBundle, { visibility: "public" }),
    });
    expect(create.status).toBe(201);
    const created = await data<CreatedSkill>(create);
    expect(created.skill).toMatchObject({
      slug: skillSlug,
      visibility: "public",
      currentSemanticVersion: "1.0.0",
      archivedAt: null,
    });
    expect(created.version).toMatchObject({
      revision: 1,
      semanticVersion: "1.0.0",
      status: "published",
    });
    expect(storage.inventory()).toHaveLength(1);

    const secondBundle = await createSkillBundleFixture({
      name: "Incident triage",
      slug: `incident-triage-${suffix.split("-").at(-1)}`,
      description: "Sort and escalate production incidents",
      tags: ["incident"],
      skillMarkdown: "# Incident triage\n\nCollect timestamps and impact.\n",
    });
    const secondCreate = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers(owner, {
          "content-type": "application/json",
          "idempotency-key": `create-second-${suffix}`,
        }),
        body: jsonUpload(secondBundle, { visibility: "private" }),
      },
    );
    expect(secondCreate.status).toBe(201);

    const firstPageResponse = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?limit=1&state=active`,
      { headers: headers(owner) },
    );
    expect(firstPageResponse.status).toBe(200);
    const firstPage = await data<{
      skills: readonly { id: string }[];
      nextCursor: string | null;
    }>(firstPageResponse);
    expect(firstPage.skills).toHaveLength(1);
    expect(firstPage.nextCursor).toEqual(expect.any(String));
    const secondPageResponse = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?limit=1&state=active&cursor=${encodeURIComponent(
        firstPage.nextCursor ?? "",
      )}`,
      { headers: headers(owner) },
    );
    expect(secondPageResponse.status).toBe(200);
    const secondPage = await data<{
      skills: readonly { id: string }[];
      nextCursor: string | null;
    }>(secondPageResponse);
    expect(secondPage.skills).toHaveLength(1);
    expect(secondPage.skills[0]?.id).not.toBe(firstPage.skills[0]?.id);

    const publicPageResponse = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?limit=1&visibility=public`,
      { headers: headers(owner) },
    );
    const publicPage = await data<{
      skills: readonly { id: string }[];
      nextCursor: string | null;
    }>(publicPageResponse);
    expect(publicPage.skills.map((skill) => skill.id)).toEqual([created.skill.id]);
    const mismatchedCursor = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?limit=1&visibility=private&cursor=${encodeURIComponent(
        publicPage.nextCursor ?? firstPage.nextCursor ?? "",
      )}`,
      { headers: headers(owner) },
    );
    expect(mismatchedCursor.status).toBe(400);
    expect(await mismatchedCursor.text()).toContain("CURSOR_FILTER_MISMATCH");

    const searchResponse = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?q=${encodeURIComponent(
        "authorization boundaries",
      )}&limit=20`,
      { headers: headers(owner) },
    );
    expect(searchResponse.status).toBe(200);
    const search = await data<{ skills: readonly { id: string }[] }>(searchResponse);
    expect(search.skills.map((skill) => skill.id)).toContain(created.skill.id);

    const bySlug = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills/by-slug/${skillSlug}`,
      { headers: headers(viewer) },
    );
    expect(bySlug.status).toBe(200);
    expect(await bySlug.text()).toContain(created.skill.id);

    const anonymousPublic = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}`,
    );
    expect(anonymousPublic.status).toBe(200);
    expect(await anonymousPublic.text()).toContain('"semanticVersion":"1.0.0"');
    const anonymousFile = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${created.version.id}/files/SKILL.md`,
    );
    expect(anonymousFile.status).toBe(200);
    expect(await anonymousFile.text()).toContain("authorization and data boundaries");
    const signedInPublicFile = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${created.version.id}/files/SKILL.md`,
      {
        headers: {
          authorization: `Bearer ${owner.sessionToken}`,
        },
      },
    );
    expect(signedInPublicFile.status).toBe(200);

    const viewerVisibility = await app.request(`/api/v1/skills/${created.skill.id}`, {
      method: "PATCH",
      headers: headers(viewer, {
        "content-type": "application/json",
        "idempotency-key": `viewer-visibility-${suffix}`,
      }),
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(viewerVisibility.status).toBe(403);

    const candidateBundle = await createSkillBundleFixture({
      name: "Pull request review",
      slug: skillSlug,
      description: "Repeatable, evidence-backed pull request reviews",
      tags: ["pull-request", "review"],
      skillMarkdown:
        "# Pull request review\n\nInspect authorization, persistence, and data boundaries before style.\n",
      files: {
        "references/checklist.md":
          "# Checklist\n\n- Confirm tenant scope\n- Verify persistence\n",
        "scripts/verify.sh": "#!/bin/sh\nexit 0\n",
      },
    });
    const viewerCandidate = await app.request(
      `/api/v1/skills/${created.skill.id}/versions`,
      {
        method: "POST",
        headers: headers(viewer, {
          "content-type": "application/json",
          "idempotency-key": `viewer-candidate-${suffix}`,
        }),
        body: jsonUpload(candidateBundle, {
          baseVersionId: created.version.id,
          proposedBump: "patch",
          changeSummary: "Viewer must not create this revision",
        }),
      },
    );
    expect(viewerCandidate.status).toBe(403);

    const candidateResponse = await app.request(
      `/api/v1/skills/${created.skill.id}/versions`,
      {
        method: "POST",
        headers: headers(owner, {
          "content-type": "application/json",
          "idempotency-key": `candidate-${suffix}`,
        }),
        body: jsonUpload(candidateBundle, {
          baseVersionId: created.version.id,
          proposedBump: "patch",
          changeSummary: "Require persistence checks before style review",
        }),
      },
    );
    expect(candidateResponse.status).toBe(201);
    const candidate = await data<{
      version: CreatedSkill["version"] & { baseVersionId: string };
    }>(candidateResponse);
    expect(candidate.version).toMatchObject({
      revision: 2,
      semanticVersion: null,
      status: "pending_review",
      baseVersionId: created.version.id,
    });
    expect(storage.inventory()).toHaveLength(3);

    const anonymousCandidate = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${candidate.version.id}`,
    );
    expect(anonymousCandidate.status).toBe(404);

    const diffResponse = await app.request(
      `/api/v1/skills/${created.skill.id}/diff?from=${created.version.id}&to=${candidate.version.id}`,
      { headers: headers(owner) },
    );
    expect(diffResponse.status).toBe(200);
    const diff = await data<{
      diff: {
        files: readonly {
          path: string;
          status: string;
          textChanges?: readonly { kind: string; value: string }[];
        }[];
      };
    }>(diffResponse);
    const skillDiff = diff.diff.files.find((file) => file.path === "SKILL.md");
    expect(skillDiff?.status).toBe("modified");
    expect(JSON.stringify(skillDiff?.textChanges)).toContain("persistence");

    const originalBundle = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${created.version.id}/bundle`,
      { headers: headers(owner) },
    );
    expect(originalBundle.status).toBe(200);
    expect(originalBundle.headers.get("content-type")).toContain("application/zip");
    expect(originalBundle.headers.get("etag")).toContain(created.version.digest);
    expect((await originalBundle.arrayBuffer()).byteLength).toBeGreaterThan(100);

    const publishResponse = await app.request(
      `/api/v1/skills/${created.skill.id}/candidates/${candidate.version.id}/approve`,
      {
        method: "POST",
        headers: headers(owner, {
          "idempotency-key": `publish-${suffix}`,
        }),
      },
    );
    expect(publishResponse.status).toBe(200);
    const published = await data<{ version: CreatedSkill["version"] }>(publishResponse);
    expect(published.version).toMatchObject({
      id: candidate.version.id,
      revision: 2,
      semanticVersion: "1.0.1",
      status: "published",
    });

    const originalAfterPublish = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${created.version.id}/files/SKILL.md`,
      { headers: headers(owner) },
    );
    expect(await originalAfterPublish.text()).not.toContain(
      "authorization, persistence",
    );
    const currentAfterPublish = await app.request(
      `/api/v1/skills/${created.skill.id}`,
      { headers: headers(owner) },
    );
    expect(currentAfterPublish.status).toBe(200);
    expect(await currentAfterPublish.text()).toContain(
      `"currentPublishedVersionId":"${candidate.version.id}"`,
    );
    expect(
      await (
        await app.request(`/api/v1/skills/public/${workspaceSlug}/${skillSlug}`)
      ).text(),
    ).toContain('"semanticVersion":"1.0.1"');

    const archivedResponse = await app.request(
      `/api/v1/skills/${created.skill.id}/archive`,
      {
        method: "POST",
        headers: headers(owner, {
          "idempotency-key": `archive-${suffix}`,
        }),
      },
    );
    expect(archivedResponse.status).toBe(200);
    const archived = await data<{ skill: CreatedSkill["skill"] }>(archivedResponse);
    expect(archived.skill.archivedAt).toEqual(expect.any(String));
    expect(archived.skill.currentPublishedVersionId).toBe(candidate.version.id);

    const archivedSearch = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?q=${encodeURIComponent(
        "authorization boundaries",
      )}`,
      { headers: headers(owner) },
    );
    expect(await archivedSearch.text()).not.toContain(created.skill.id);
    const archivedHistory = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${created.version.id}/files/SKILL.md`,
      { headers: headers(owner) },
    );
    expect(archivedHistory.status).toBe(200);
    expect(
      (await app.request(`/api/v1/skills/public/${workspaceSlug}/${skillSlug}`)).status,
    ).toBe(404);

    const restoredResponse = await app.request(
      `/api/v1/skills/${created.skill.id}/restore`,
      {
        method: "POST",
        headers: headers(owner, {
          "idempotency-key": `restore-${suffix}`,
        }),
      },
    );
    expect(restoredResponse.status).toBe(200);
    const restored = await data<{ skill: CreatedSkill["skill"] }>(restoredResponse);
    expect(restored.skill).toMatchObject({
      visibility: "public",
      archivedAt: null,
      currentPublishedVersionId: candidate.version.id,
      currentSemanticVersion: "1.0.1",
    });
    expect(
      (await app.request(`/api/v1/skills/public/${workspaceSlug}/${skillSlug}`)).status,
    ).toBe(200);
  });
});
