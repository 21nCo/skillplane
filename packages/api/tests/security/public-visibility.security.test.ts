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

let databaseUrl: string;
let services: ApiServices;
let tenant: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const suffix = `public-visibility-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const workspaceSlug = `workspace-${suffix}`;

function headers(idempotencyKey?: string): Record<string, string> {
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
  visibility: "private" | "workspace" | "public",
  label: string,
): Promise<{
  readonly slug: string;
  readonly skillId: string;
  readonly versionId: string;
  readonly digest: string;
}> {
  const slug = `${label}-${suffix}`;
  const bundle = await createSkillBundleFixture({
    name: `${label} skill`,
    slug,
    description: `${label} skill visibility fixture`,
    tags: [label],
    skillMarkdown: `# ${label}\n\nPublished ${label} guidance.\n`,
  });
  const response = await app.request(
    `/api/v1/workspaces/${tenant.workspaceId}/skills`,
    {
      method: "POST",
      headers: headers(`create-${label}-${suffix}`),
      body: JSON.stringify({
        bundleBase64: Buffer.from(bundle).toString("base64"),
        visibility,
      }),
    },
  );
  expect(response.status).toBe(201);
  const body = (await response.json()) as {
    data: {
      skill: { id: string };
      version: { id: string; digest: string };
    };
  };
  return {
    slug,
    skillId: body.data.skill.id,
    versionId: body.data.version.id,
    digest: body.data.version.digest,
  };
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  tenant = await seedTenantFixture(databaseUrl, suffix);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  app = createApiApp({
    requestId: () => `req_public_visibility_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, suffix);
});

describe("public skill visibility", () => {
  let publicSkill: Awaited<ReturnType<typeof createSkill>>;
  let privateSkill: Awaited<ReturnType<typeof createSkill>>;
  let workspaceSkill: Awaited<ReturnType<typeof createSkill>>;

  it("only exposes published public rows and never candidate or context knowledge", async () => {
    publicSkill = await createSkill("public", "public");
    privateSkill = await createSkill("private", "privatesecret");
    workspaceSkill = await createSkill("workspace", "workspacesecret");

    await services.database.pool.query(
      `INSERT INTO skill_contexts
         (id, workspace_id, skill_id, slug, name, description)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        `context:${suffix}:secret`,
        tenant.workspaceId,
        publicSkill.skillId,
        `project-${suffix}`,
        "contextsecret project",
        "contextsecret knowledge must stay private",
      ],
    );
    const candidateBundle = await createSkillBundleFixture({
      name: "public skill",
      slug: publicSkill.slug,
      description: "public skill visibility fixture",
      tags: ["public"],
      skillMarkdown: "# candidatesecret\n\nUnpublished candidate guidance.\n",
    });
    const candidateResponse = await app.request(
      `/api/v1/skills/${publicSkill.skillId}/versions`,
      {
        method: "POST",
        headers: headers(`candidate-${suffix}`),
        body: JSON.stringify({
          bundleBase64: Buffer.from(candidateBundle).toString("base64"),
          baseVersionId: publicSkill.versionId,
          proposedBump: "patch",
          changeSummary: "Candidate-only secret",
        }),
      },
    );
    expect(candidateResponse.status).toBe(201);
    const candidate = (await candidateResponse.json()) as {
      data: { version: { id: string } };
    };

    const directory = await app.request("/api/v1/skills/public");
    const directoryText = await directory.text();
    expect(directory.status).toBe(200);
    expect(directoryText).toContain(publicSkill.skillId);
    expect(directoryText).not.toContain(privateSkill.skillId);
    expect(directoryText).not.toContain(workspaceSkill.skillId);
    expect(directoryText).not.toContain("contextsecret");
    expect(directoryText).not.toContain("candidatesecret");

    for (const query of [
      "privatesecret",
      "workspacesecret",
      "contextsecret",
      "candidatesecret",
    ]) {
      const response = await app.request(
        `/api/v1/skills/public?q=${encodeURIComponent(query)}`,
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toContain('"skills":[]');
    }

    for (const hidden of [privateSkill, workspaceSkill]) {
      expect(
        (await app.request(`/api/v1/skills/public/${workspaceSlug}/${hidden.slug}`))
          .status,
      ).toBe(404);
      expect(
        (
          await app.request(
            `/api/v1/skills/public/${workspaceSlug}/${hidden.slug}/versions`,
          )
        ).status,
      ).toBe(404);
    }

    const history = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${publicSkill.slug}/versions`,
    );
    const historyText = await history.text();
    expect(history.status).toBe(200);
    expect(historyText).toContain(publicSkill.versionId);
    expect(historyText).not.toContain(candidate.data.version.id);
    expect(historyText).not.toContain("learningMetadata");
    expect(historyText).not.toContain("callerDeclaration");
  });

  it("revokes origin access to current, history, discovery, and digest files", async () => {
    const encodedDigest = encodeURIComponent(publicSkill.digest);
    const filePath =
      `/api/v1/skills/public/${workspaceSlug}/${publicSkill.slug}/versions/` +
      `${encodeURIComponent(publicSkill.versionId)}/${encodedDigest}/files/SKILL.md`;
    expect((await app.request(filePath)).status).toBe(200);

    const revoke = await app.request(`/api/v1/skills/${publicSkill.skillId}`, {
      method: "PATCH",
      headers: headers(`revoke-${suffix}`),
      body: JSON.stringify({ visibility: "private" }),
    });
    expect(revoke.status).toBe(200);

    expect(
      (await app.request(`/api/v1/skills/public/${workspaceSlug}/${publicSkill.slug}`))
        .status,
    ).toBe(404);
    expect(
      (
        await app.request(
          `/api/v1/skills/public/${workspaceSlug}/${publicSkill.slug}/versions`,
        )
      ).status,
    ).toBe(404);
    expect((await app.request(filePath)).status).toBe(404);
    const directory = await app.request("/api/v1/skills/public");
    expect(await directory.text()).not.toContain(publicSkill.skillId);
  });
});
