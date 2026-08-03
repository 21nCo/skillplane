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
let tenantA: TenantFixture;
let tenantB: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
const sharedTerm = `sharedterm${suffix}`;

function headers(
  tenant: TenantFixture,
  idempotencyKey?: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": tenant.workspaceId,
    ...(idempotencyKey
      ? {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
        }
      : {}),
  };
}

async function createSkill(
  tenant: TenantFixture,
  options: {
    readonly slug: string;
    readonly name: string;
    readonly markdown: string;
    readonly visibility: "private" | "workspace" | "public";
    readonly tags?: readonly string[];
  },
): Promise<{ skillId: string; versionId: string }> {
  const bundle = await createSkillBundleFixture({
    name: options.name,
    slug: options.slug,
    description: `${options.name} description`,
    tags: options.tags,
    skillMarkdown: options.markdown,
  });
  const response = await app.request(
    `/api/v1/workspaces/${tenant.workspaceId}/skills`,
    {
      method: "POST",
      headers: headers(tenant, `create-${options.slug}`),
      body: JSON.stringify({
        visibility: options.visibility,
        bundleBase64: Buffer.from(bundle).toString("base64"),
      }),
    },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    data: { skill: { id: string }; version: { id: string } };
  };
  return {
    skillId: body.data.skill.id,
    versionId: body.data.version.id,
  };
}

beforeAll(async () => {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  tenantA = await seedTenantFixture(databaseUrl, `search-a-${suffix}`);
  tenantB = await seedTenantFixture(databaseUrl, `search-b-${suffix}`);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
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

describe("tenant-safe skill search", () => {
  let privateA: { skillId: string; versionId: string };
  let publicA: { skillId: string; versionId: string };
  let publicB: { skillId: string; versionId: string };
  let privateB: { skillId: string; versionId: string };

  it("prepares public and private releases in two workspaces", async () => {
    privateA = await createSkill(tenantA, {
      slug: `private-a-${suffix}`,
      name: `${sharedTerm} private alpha`,
      markdown: `# ${sharedTerm}\n\nAlpha-only private guidance.\n`,
      visibility: "private",
      tags: [sharedTerm],
    });
    publicA = await createSkill(tenantA, {
      slug: `public-a-${suffix}`,
      name: `${sharedTerm} public alpha`,
      markdown: `# ${sharedTerm}\n\nAlpha public guidance.\n`,
      visibility: "public",
      tags: [sharedTerm],
    });
    publicB = await createSkill(tenantB, {
      slug: `public-b-${suffix}`,
      name: `${sharedTerm} public beta`,
      markdown: `# ${sharedTerm}\n\nBeta public guidance.\n`,
      visibility: "public",
      tags: [sharedTerm],
    });
    privateB = await createSkill(tenantB, {
      slug: `private-b-${suffix}`,
      name: "Leaksecret beta",
      markdown: "# Leaksecret\n\nNever cross the tenant boundary.\n",
      visibility: "private",
      tags: ["leaksecret"],
    });
    expect(
      new Set([privateA.skillId, publicA.skillId, publicB.skillId, privateB.skillId])
        .size,
    ).toBe(4);
  });

  it("authorizes before ranking and never returns another workspace's rows", async () => {
    const workspaceSearch = await app.request(`/api/v1/skills/search?q=${sharedTerm}`, {
      headers: headers(tenantA),
    });
    expect(workspaceSearch.status).toBe(200);
    const body = (await workspaceSearch.json()) as {
      data: { skills: { id: string; score: string }[]; nextCursor: string | null };
    };
    expect(body.data.skills.map((skill) => skill.id).sort()).toEqual(
      [privateA.skillId, publicA.skillId].sort(),
    );
    expect(JSON.stringify(body)).not.toContain(publicB.skillId);
    expect(JSON.stringify(body)).not.toContain(privateB.skillId);
    expect(body.data).not.toHaveProperty("total");
    const repeated = await app.request(`/api/v1/skills/search?q=${sharedTerm}`, {
      headers: headers(tenantA),
    });
    const repeatedBody = (await repeated.json()) as typeof body;
    expect(repeatedBody.data.skills).toEqual(body.data.skills);

    const forbiddenTerm = await app.request("/api/v1/skills/search?q=leaksecret", {
      headers: headers(tenantA),
    });
    const forbiddenBody = (await forbiddenTerm.json()) as {
      data: { skills: unknown[] };
    };
    expect(forbiddenBody.data.skills).toEqual([]);
  });

  it("anonymous search returns only published public releases", async () => {
    const response = await app.request(`/api/v1/skills/search?q=${sharedTerm}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      data: { skills: { id: string }[] };
    };
    expect(body.data.skills.map((skill) => skill.id).sort()).toEqual(
      [publicA.skillId, publicB.skillId].sort(),
    );
    expect(JSON.stringify(body)).not.toContain(privateA.skillId);
    expect(JSON.stringify(body)).not.toContain(privateB.skillId);

    const publicSkill = await app.request(`/api/v1/skills/${publicA.skillId}`);
    expect(publicSkill.status).toBe(200);
    const publicVersion = await app.request(
      `/api/v1/skills/${publicA.skillId}/versions/${publicA.versionId}`,
    );
    expect(publicVersion.status).toBe(200);
    const privateSkill = await app.request(`/api/v1/skills/${privateA.skillId}`);
    expect(privateSkill.status).toBe(404);
  });

  it("excludes context and candidate-only knowledge from public search", async () => {
    await services.database.pool.query(
      `INSERT INTO skill_contexts
         (id, workspace_id, skill_id, slug, name, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `context:search-${suffix}`,
        tenantA.workspaceId,
        publicA.skillId,
        `context-${suffix}`,
        "Contextonlysecret project",
        "Private project vocabulary",
      ],
    );
    const anonymousContext = await app.request(
      "/api/v1/skills/search?q=contextonlysecret",
    );
    const anonymousContextBody = (await anonymousContext.json()) as {
      data: { skills: unknown[] };
    };
    expect(anonymousContextBody.data.skills).toEqual([]);

    const workspaceContext = await app.request(
      "/api/v1/skills/search?q=contextonlysecret",
      { headers: headers(tenantA) },
    );
    const workspaceContextBody = (await workspaceContext.json()) as {
      data: { skills: { id: string }[] };
    };
    expect(workspaceContextBody.data.skills.map((skill) => skill.id)).toEqual([
      publicA.skillId,
    ]);

    const candidateBundle = await createSkillBundleFixture({
      name: `${sharedTerm} public alpha`,
      slug: `public-a-${suffix}`,
      skillMarkdown: "# Candidateonlysecret\n\nNot published yet.\n",
    });
    const candidate = await app.request(`/api/v1/skills/${publicA.skillId}/versions`, {
      method: "POST",
      headers: headers(tenantA, `candidate-search-${suffix}`),
      body: JSON.stringify({
        bundleBase64: Buffer.from(candidateBundle).toString("base64"),
        baseVersionId: publicA.versionId,
        proposedBump: "patch",
        changeSummary: "Unpublished candidate term",
      }),
    });
    expect(candidate.status).toBe(201);
    const candidateResponse = (await candidate.json()) as {
      data: { version: { id: string } };
    };
    const anonymousCandidate = await app.request(
      `/api/v1/skills/${publicA.skillId}/versions/${candidateResponse.data.version.id}`,
    );
    expect(anonymousCandidate.status).toBe(404);
    const candidateSearch = await app.request(
      "/api/v1/skills/search?q=candidateonlysecret",
    );
    const candidateBody = (await candidateSearch.json()) as {
      data: { skills: unknown[] };
    };
    expect(candidateBody.data.skills).toEqual([]);
  });

  it("binds signed cursors to filters and rejects tampering", async () => {
    const first = await app.request(`/api/v1/skills/search?q=${sharedTerm}&limit=1`);
    expect(first.status).toBe(200);
    const page = (await first.json()) as {
      data: { nextCursor: string | null };
    };
    expect(page.data.nextCursor).toBeTruthy();
    const cursor = page.data.nextCursor;
    if (!cursor) throw new Error("Expected a second public search page");
    const second = await app.request(
      `/api/v1/skills/search?q=${sharedTerm}&limit=1&cursor=${encodeURIComponent(
        cursor,
      )}`,
    );
    expect(second.status).toBe(200);
    const secondPage = (await second.json()) as {
      data: { skills: { id: string }[] };
    };
    expect(secondPage.data.skills).toHaveLength(1);

    const changedFilter = await app.request(
      `/api/v1/skills/search?q=${sharedTerm}&limit=1&tag=other&cursor=${encodeURIComponent(
        cursor,
      )}`,
    );
    expect(changedFilter.status).toBe(400);
    expect(await changedFilter.text()).toContain("CURSOR_FILTER_MISMATCH");

    const finalCharacter = cursor.endsWith("A") ? "B" : "A";
    const tampered = `${cursor.slice(0, -1)}${finalCharacter}`;
    const tamperedResponse = await app.request(
      `/api/v1/skills/search?q=${sharedTerm}&limit=1&cursor=${encodeURIComponent(
        tampered,
      )}`,
    );
    expect(tamperedResponse.status).toBe(400);
    expect(await tamperedResponse.text()).toContain("CURSOR_INVALID");
  });
});
