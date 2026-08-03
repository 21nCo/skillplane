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
const suffix = `public-skills-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
const workspaceSlug = `workspace-${suffix}`;
const reviewSlug = `pull-request-review-${suffix}`;
const discoveryTerm = `authboundary${suffix.replaceAll("-", "")}`;

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

async function data<T>(response: Response): Promise<T> {
  const envelope = (await response.json()) as { readonly data: T };
  return envelope.data;
}

async function createSkill(options: {
  readonly slug: string;
  readonly name: string;
  readonly markdown: string;
  readonly visibility: "private" | "public";
  readonly tags?: readonly string[];
}): Promise<{
  readonly skill: { readonly id: string };
  readonly version: {
    readonly id: string;
    readonly digest: `sha256:${string}`;
  };
}> {
  const bundle = await createSkillBundleFixture({
    name: options.name,
    slug: options.slug,
    description: `${options.name} production guidance`,
    tags: options.tags,
    skillMarkdown: options.markdown,
  });
  const response = await app.request(
    `/api/v1/workspaces/${tenant.workspaceId}/skills`,
    {
      method: "POST",
      headers: headers(`create-${options.slug}`),
      body: JSON.stringify({
        bundleBase64: Buffer.from(bundle).toString("base64"),
        visibility: options.visibility,
      }),
    },
  );
  expect(response.status).toBe(201);
  return data(response);
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  tenant = await seedTenantFixture(databaseUrl, suffix);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  app = createApiApp({
    requestId: () => `req_public_skills_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, suffix);
});

describe("public skill discovery API", () => {
  let review: Awaited<ReturnType<typeof createSkill>>;
  let triage: Awaited<ReturnType<typeof createSkill>>;

  it("browses public skills without a query using deterministic signed cursors", async () => {
    review = await createSkill({
      slug: reviewSlug,
      name: "Pull request review",
      markdown: `# Pull request review\n\nInspect ${discoveryTerm} boundaries first.\n`,
      visibility: "public",
      tags: ["review", "pull-request"],
    });
    triage = await createSkill({
      slug: `incident-triage-${suffix}`,
      name: "Incident triage",
      markdown: "# Incident triage\n\nCollect impact and timestamps.\n",
      visibility: "public",
      tags: ["incident"],
    });
    await createSkill({
      slug: `private-runbook-${suffix}`,
      name: "Private runbook",
      markdown: "# Private runbook\n\nNever publicly discoverable.\n",
      visibility: "private",
    });

    const first = await app.request("/api/v1/skills/public?limit=1");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    const firstPage = await data<{
      skills: readonly { id: string; score: string }[];
      nextCursor: string | null;
    }>(first);
    expect(firstPage.skills).toHaveLength(1);
    expect(firstPage.skills[0]?.score).toBe("0");
    expect(firstPage.nextCursor).toEqual(expect.any(String));

    const repeated = await data<typeof firstPage>(
      await app.request("/api/v1/skills/public?limit=1"),
    );
    expect(repeated.skills).toEqual(firstPage.skills);
    const second = await app.request(
      `/api/v1/skills/public?limit=1&cursor=${encodeURIComponent(
        firstPage.nextCursor ?? "",
      )}`,
    );
    expect(second.status).toBe(200);
    const secondPage = await data<typeof firstPage>(second);
    expect(secondPage.skills).toHaveLength(1);
    expect(secondPage.skills[0]?.id).not.toBe(firstPage.skills[0]?.id);

    const changedFilter = await app.request(
      `/api/v1/skills/public?q=review&limit=1&cursor=${encodeURIComponent(
        firstPage.nextCursor ?? "",
      )}`,
    );
    expect(changedFilter.status).toBe(400);
    expect(await changedFilter.text()).toContain("CURSOR_FILTER_MISMATCH");
  });

  it("uses authorization-safe full-text ranking when a public query is supplied", async () => {
    const response = await app.request(`/api/v1/skills/public?q=${discoveryTerm}`);
    expect(response.status).toBe(200);
    const page = await data<{
      skills: readonly {
        id: string;
        workspaceSlug: string;
        slug: string;
        score: string;
      }[];
    }>(response);
    expect(page.skills.map((skill) => skill.id)).toEqual([review.skill.id]);
    expect(BigInt(page.skills[0]?.score ?? "0")).toBeGreaterThan(0n);
    expect(page.skills[0]?.workspaceSlug).toBe(workspaceSlug);
  });

  it("revalidates the mutable current pointer and exposes immutable digest files", async () => {
    const skillSlug = reviewSlug;
    const current = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}`,
    );
    expect(current.status).toBe(200);
    expect(current.headers.get("cache-control")).toBe(
      "public, max-age=0, must-revalidate",
    );
    const currentEtag = current.headers.get("etag");
    expect(currentEtag).toContain(review.version.digest);
    const notModified = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}`,
      { headers: { "if-none-match": currentEtag ?? "" } },
    );
    expect(notModified.status).toBe(304);

    const encodedDigest = encodeURIComponent(review.version.digest);
    const filePath =
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}/versions/` +
      `${encodeURIComponent(review.version.id)}/${encodedDigest}/files/SKILL.md`;
    const file = await app.request(filePath);
    expect(file.status).toBe(200);
    expect(file.headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(await file.text()).toContain(`${discoveryTerm} boundaries`);
    const fileEtag = file.headers.get("etag");
    const cached = await app.request(filePath, {
      headers: { "if-none-match": fileEtag ?? "" },
    });
    expect(cached.status).toBe(304);
    expect(
      (
        await app.request(
          filePath.replace(
            encodedDigest,
            encodeURIComponent(`sha256:${"f".repeat(64)}`),
          ),
        )
      ).status,
    ).toBe(404);
  });

  it("updates current-pointer validators and published history after publication", async () => {
    const skillSlug = reviewSlug;
    const candidateBundle = await createSkillBundleFixture({
      name: "Pull request review",
      slug: skillSlug,
      description: "Pull request review production guidance",
      tags: ["review", "pull-request"],
      skillMarkdown:
        "# Pull request review\n\nInspect authorization, persistence, and boundaries first.\n",
    });
    const candidateResponse = await app.request(
      `/api/v1/skills/${review.skill.id}/versions`,
      {
        method: "POST",
        headers: headers(`candidate-${suffix}`),
        body: JSON.stringify({
          bundleBase64: Buffer.from(candidateBundle).toString("base64"),
          baseVersionId: review.version.id,
          proposedBump: "patch",
          changeSummary: "Add persistence verification",
        }),
      },
    );
    expect(candidateResponse.status).toBe(201);
    const candidate = await data<{
      version: { readonly id: string; readonly digest: `sha256:${string}` };
    }>(candidateResponse);

    const beforeHistory = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}/versions`,
    );
    const before = await data<{ versions: readonly { id: string }[] }>(beforeHistory);
    expect(before.versions.map((version) => version.id)).not.toContain(
      candidate.version.id,
    );

    const publish = await app.request(
      `/api/v1/skills/${review.skill.id}/candidates/${candidate.version.id}/approve`,
      {
        method: "POST",
        headers: headers(`publish-${suffix}`),
      },
    );
    expect(publish.status).toBe(200);

    const afterCurrent = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}`,
    );
    expect(afterCurrent.headers.get("etag")).toContain(candidate.version.digest);
    expect(afterCurrent.headers.get("etag")).not.toContain(review.version.digest);
    expect(await afterCurrent.text()).toContain('"semanticVersion":"1.0.1"');

    const afterHistory = await app.request(
      `/api/v1/skills/public/${workspaceSlug}/${skillSlug}/versions`,
    );
    expect(afterHistory.status).toBe(200);
    const history = await data<{
      versions: readonly {
        id: string;
        semanticVersion: string;
        learningMetadata?: unknown;
      }[];
    }>(afterHistory);
    expect(history.versions.map((version) => version.semanticVersion)).toEqual([
      "1.0.1",
      "1.0.0",
    ]);
    expect(history.versions[0]).not.toHaveProperty("learningMetadata");
    expect(history.versions[0]?.id).toBe(candidate.version.id);
    expect(triage.skill.id).not.toBe(review.skill.id);
  });
});
