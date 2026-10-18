import { createHash } from "node:crypto";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import { createSkillBundle } from "@skillplane/domain";
import {
  createSkillBundleFixture,
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";

let databaseUrl: string;
let services: ApiServices;
let owner: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const suffix = `instructions-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

function headers(idempotencyKey?: string): Record<string, string> {
  return {
    authorization: `Bearer ${owner.sessionToken}`,
    "x-skillplane-workspace-id": owner.workspaceId,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { readonly data: T }).data;
}

async function errorCode(response: Response): Promise<string> {
  return ((await response.json()) as { readonly error: { readonly code: string } })
    .error.code;
}

function instructionsBundle(slug: string, document: string) {
  return createSkillBundle({
    kind: "instructions",
    name: "Repository agents",
    slug,
    description: "Shared AGENTS.md guidance",
    tags: ["agents"],
    instructions: document,
    assets: [],
  });
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

interface CreatedArtifact {
  readonly skill: { readonly id: string; readonly kind: string; readonly slug: string };
  readonly version: {
    readonly id: string;
    readonly revision: number;
    readonly digest: string;
  };
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, suffix);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
    SKILL_COMPOSITION_WRITES_ENABLED: "true",
  });
  app = createApiApp({
    requestId: () => `req_instructions_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, suffix);
});

describe("instructions artifacts over the API", () => {
  it("runs the versioned lifecycle and stays out of skill listing and resolution", async () => {
    const slug = `agents-${suffix.split("-").at(-1)}`;
    const document = "# Repository agents\n\nRun pnpm test before handing off.\n";
    const bundle = await instructionsBundle(slug, document);

    const publicCreate = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers(`public-${suffix}`),
        body: JSON.stringify({
          bundleBase64: base64(bundle.bytes),
          visibility: "public",
        }),
      },
    );
    expect(publicCreate.status).toBe(400);
    expect(await errorCode(publicCreate)).toBe("SKILL_VISIBILITY_INVALID");

    const create = await app.request(`/api/v1/workspaces/${owner.workspaceId}/skills`, {
      method: "POST",
      headers: headers(`create-${suffix}`),
      body: JSON.stringify({
        bundleBase64: base64(bundle.bytes),
        visibility: "workspace",
      }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const created = await data<CreatedArtifact>(create);
    expect(created.skill.kind).toBe("instructions");
    expect(created.version).toMatchObject({ revision: 1, digest: bundle.digest });

    const makePublic = await app.request(`/api/v1/skills/${created.skill.id}`, {
      method: "PATCH",
      headers: headers(`make-public-${suffix}`),
      body: JSON.stringify({ visibility: "public" }),
    });
    expect(makePublic.status).toBe(400);
    expect(await errorCode(makePublic)).toBe("SKILL_VISIBILITY_INVALID");

    // Amendment, then review approval.
    const amendedDocument = `${document}\nNever push without a passing pnpm lint.\n`;
    const amendment = await app.request(
      `/api/v1/skills/${created.skill.id}/amendments`,
      {
        method: "POST",
        headers: headers(`amend-${suffix}`),
        body: JSON.stringify({
          baseVersionId: created.version.id,
          proposedBump: "minor",
          changes: [
            {
              operation: "replace",
              path: "AGENTS.md",
              expectedSha256: createHash("sha256").update(document).digest("hex"),
              content: amendedDocument,
            },
          ],
          learning: {
            summary: "Require lint before push",
            observation: "Agents pushed without linting.",
            rationale: "The instructions must name the lint gate.",
            confidence: "high",
            evidence: [
              {
                kind: "integration",
                reference: "instructions:lint",
                description: "The pushed change failed lint.",
              },
            ],
            validation: [
              {
                kind: "integration",
                status: "passed",
                description: "The amended document was read back.",
              },
            ],
          },
          caller: {
            agent: "codex",
            model: "gpt-5",
            client: "skillplane-api",
            runId: `run:${suffix}`,
            sessionId: `session:${suffix}`,
            conversationId: `conversation:${suffix}`,
          },
        }),
      },
    );
    expect(amendment.status, await amendment.clone().text()).toBe(201);
    const candidate = await data<{
      candidate: { id: string; revision: number; status: string };
      review: { id: string };
    }>(amendment);
    expect(candidate.candidate).toMatchObject({
      revision: 2,
      status: "pending_review",
    });
    const approval = await app.request(
      `/api/v1/skills/${created.skill.id}/reviews/${candidate.review.id}/approve`,
      {
        method: "POST",
        headers: headers(`approve-${suffix}`),
        body: JSON.stringify({ reason: "The lint gate is now explicit." }),
      },
    );
    expect(approval.status, await approval.clone().text()).toBe(200);
    expect(
      (await data<{ candidate: { status: string; semanticVersion: string } }>(approval))
        .candidate,
    ).toMatchObject({ status: "published", semanticVersion: "1.1.0" });

    // A direct candidate keeps its kind and publishes through review.
    const revised = await instructionsBundle(
      slug,
      `${amendedDocument}\nKeep PRs small.\n`,
    );
    const directCandidate = await app.request(
      `/api/v1/skills/${created.skill.id}/versions`,
      {
        method: "POST",
        headers: headers(`direct-${suffix}`),
        body: JSON.stringify({
          bundleBase64: base64(revised.bytes),
          baseVersionId: candidate.candidate.id,
          proposedBump: "patch",
          changeSummary: "Ask for small pull requests",
        }),
      },
    );
    expect(directCandidate.status, await directCandidate.clone().text()).toBe(201);
    const direct = await data<{ version: { id: string; revision: number } }>(
      directCandidate,
    );
    const published = await app.request(
      `/api/v1/skills/${created.skill.id}/candidates/${direct.version.id}/approve`,
      { method: "POST", headers: headers(`publish-${suffix}`), body: "{}" },
    );
    expect(published.status, await published.clone().text()).toBe(200);

    const read = await app.request(`/api/v1/skills/${created.skill.id}`, {
      headers: headers(),
    });
    const current = (
      await data<{ skill: { kind: string; currentSemanticVersion: string } }>(read)
    ).skill;
    expect(current).toMatchObject({
      kind: "instructions",
      currentSemanticVersion: "1.1.1",
    });
    const versions = await app.request(`/api/v1/skills/${created.skill.id}/versions`, {
      headers: headers(),
    });
    expect(
      (await data<{ versions: { revision: number; digest: string }[] }>(versions))
        .versions[0],
    ).toEqual(expect.objectContaining({ revision: 3, digest: revised.digest }));

    // The kind is immutable: a SKILL.md bundle cannot become a revision.
    const skillBundle = await createSkillBundleFixture({
      name: "Repository agents",
      slug,
      skillMarkdown: "# Not instructions\n",
    });
    const crossKind = await app.request(`/api/v1/skills/${created.skill.id}/versions`, {
      method: "POST",
      headers: headers(`cross-kind-${suffix}`),
      body: JSON.stringify({
        bundleBase64: base64(skillBundle),
        baseVersionId: direct.version.id,
        proposedBump: "major",
        changeSummary: "Turn instructions into a skill",
      }),
    });
    expect(crossKind.status).toBe(400);
    expect(await errorCode(crossKind)).toBe("SKILL_BUNDLE_INVALID");

    const skillsOnly = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?kind=skill&limit=100`,
      { headers: headers() },
    );
    const skillIds = (
      await data<{ skills: { id: string; kind: string }[] }>(skillsOnly)
    ).skills;
    expect(skillIds.map((skill) => skill.id)).toContain(owner.skillId);
    expect(skillIds.map((skill) => skill.id)).not.toContain(created.skill.id);
    expect(new Set(skillIds.map((skill) => skill.kind))).toEqual(new Set(["skill"]));
    const instructionsOnly = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?kind=instructions`,
      { headers: headers() },
    );
    expect(
      (await data<{ skills: { id: string }[] }>(instructionsOnly)).skills.map(
        (skill) => skill.id,
      ),
    ).toEqual([created.skill.id]);
    const searchedSkills = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?q=repository&kind=skill`,
      { headers: headers() },
    );
    expect(
      (await data<{ skills: { id: string }[] }>(searchedSkills)).skills.map(
        (skill) => skill.id,
      ),
    ).not.toContain(created.skill.id);
    const badKind = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills?kind=agent`,
      { headers: headers() },
    );
    expect(badKind.status).toBe(400);

    const resolve = await app.request(
      `/api/v1/skills/${created.skill.id}/versions/${direct.version.id}/resolve`,
      { headers: headers() },
    );
    expect(resolve.status).toBe(400);
    expect(await errorCode(resolve)).toBe("SKILL_KIND_UNSUPPORTED");

    const workspace = await services.database.pool.query<{ slug: string }>(
      "SELECT slug FROM workspaces WHERE id = $1",
      [owner.workspaceId],
    );
    const composite = await createSkillBundle({
      name: "Depends on agents",
      slug: `depends-${slug}`,
      description: "",
      tags: [],
      instructions: "# Composite\n\nUse the repository guidance.\n",
      assets: [],
      composition: {
        dependencies: [
          {
            alias: "agents",
            workspace: workspace.rows[0]?.slug ?? "",
            skill: slug,
            version: "^1.0.0",
            scope: "execution",
            mode: "include",
            required: true,
          },
        ],
        verify: false,
        blocking: false,
      },
    });
    const dependent = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/skills`,
      {
        method: "POST",
        headers: headers(`dependent-${suffix}`),
        body: JSON.stringify({
          bundleBase64: base64(composite.bytes),
          visibility: "workspace",
        }),
      },
    );
    expect(dependent.status).toBe(409);
    const dependencyError = (
      (await dependent.json()) as { error: { code: string; message: string } }
    ).error;
    expect(dependencyError.code).toBe("SKILL_DEPENDENCY_CONFLICT");
    expect(dependencyError.message).toContain("instructions document");
  });
});
