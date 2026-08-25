import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import { rollupUtcDay, writeAuditEvent } from "@skillplane/observability";
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

  it("publishes aggregate skill and successful agent-use totals", async () => {
    const workspaceSkillsBefore = await services.database.pool.query<{
      total: string;
    }>(
      `SELECT count(*)::text AS total
         FROM skills
        WHERE workspace_id = $1 AND archived_at IS NULL`,
      [tenant.workspaceId],
    );
    const beforeResponse = await app.request("/api/v1/stats/public");
    expect(beforeResponse.status).toBe(200);
    expect(beforeResponse.headers.get("cache-control")).toBe(
      "public, max-age=60, s-maxage=300, stale-while-revalidate=3600",
    );
    const before = await data<{
      readonly totalSkills: string;
      readonly agentSkillUses: string;
      readonly generatedAt: string;
    }>(beforeResponse);
    const countersBefore = await services.database.pool.query<{
      id: string;
      agent_skill_uses: string;
    }>(
      `SELECT id, agent_skill_uses::text
         FROM public_stats_counters
        WHERE id IN ('global', $1)`,
      [tenant.workspaceId],
    );
    const counterBefore = new Map(
      countersBefore.rows.map((row) => [row.id, BigInt(row.agent_skill_uses)]),
    );

    const measured = await createSkill({
      slug: `agent-usage-${suffix}`,
      name: "Agent usage",
      markdown: "# Agent usage\n\nMeasure successful retrievals only.\n",
      visibility: "private",
    });
    const dayStart = new Date(Date.now() - 2 * 86_400_000);
    dayStart.setUTCHours(0, 0, 0, 0);
    const day = dayStart.toISOString().slice(0, 10);
    const recordUse = async (index: number, hour: number): Promise<void> => {
      await writeAuditEvent(services.database.pool, {
        id: `audit:public-stats:${suffix}:${String(index)}`,
        workspaceId: tenant.workspaceId,
        eventType: "mcp.skill_retrieve.success",
        action: "skill_retrieve",
        outcome: "success",
        actorType: "service_principal",
        actorId: `service:public-stats:${suffix}`,
        requestId: `request:public-stats:${suffix}:${String(index)}`,
        resourceType: "skill_version",
        resourceId: measured.version.id,
        skillId: measured.skill.id,
        versionId: measured.version.id,
        agent: "Codex",
        model: "gpt-5",
        channel: "mcp",
        retentionClass: "detailed_read_90d",
        occurredAt: new Date(dayStart.getTime() + hour * 3_600_000),
      });
    };

    await recordUse(1, 10);
    await recordUse(2, 11);
    await rollupUtcDay(services.database.pool, {
      day,
      workspaceId: tenant.workspaceId,
    });
    await recordUse(3, 11);
    await recordUse(4, 12);

    const countersAfter = await services.database.pool.query<{
      id: string;
      agent_skill_uses: string;
    }>(
      `SELECT id, agent_skill_uses::text
         FROM public_stats_counters
        WHERE id IN ('global', $1)`,
      [tenant.workspaceId],
    );
    const counterAfter = new Map(
      countersAfter.rows.map((row) => [row.id, BigInt(row.agent_skill_uses)]),
    );
    expect(counterAfter.get("global")).toBe(counterBefore.get("global"));
    expect(counterAfter.get(tenant.workspaceId)).toBe(
      (counterBefore.get(tenant.workspaceId) ?? 0n) + 4n,
    );

    const statsClient = await services.database.pool.connect();
    let expectedTotalSkills: string;
    let snapshotTotalSkills: string;
    try {
      await statsClient.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
      const expected = await statsClient.query<{ total: string }>(
        `SELECT count(*)::text AS total
           FROM skills
          WHERE archived_at IS NULL`,
      );
      expectedTotalSkills = expected.rows[0]?.total ?? "0";
      const snapshotServices: ApiServices = {
        ...services,
        database: {
          ...services.database,
          pool: {
            query: statsClient.query.bind(statsClient),
          } as unknown as typeof services.database.pool,
        },
      };
      const snapshotApp = createApiApp({
        requestId: () => `req_public_skills_snapshot_${suffix}`,
        getServices: async () => snapshotServices,
      });
      const snapshotResponse = await snapshotApp.request("/api/v1/stats/public");
      expect(snapshotResponse.status).toBe(200);
      snapshotTotalSkills = (
        await data<{ readonly totalSkills: string }>(snapshotResponse)
      ).totalSkills;
      await statsClient.query("COMMIT");
    } catch (error) {
      await statsClient.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      statsClient.release();
    }
    const afterResponse = await app.request("/api/v1/stats/public");
    const responseText = await afterResponse.text();
    expect(afterResponse.status).toBe(200);
    expect(responseText).not.toContain(tenant.workspaceId);
    expect(responseText).not.toContain(measured.skill.id);
    const envelope = JSON.parse(responseText) as {
      readonly data: {
        readonly totalSkills: string;
        readonly agentSkillUses: string;
        readonly generatedAt: string;
      };
    };
    const workspaceSkillsAfter = await services.database.pool.query<{
      total: string;
    }>(
      `SELECT count(*)::text AS total
         FROM skills
        WHERE workspace_id = $1 AND archived_at IS NULL`,
      [tenant.workspaceId],
    );
    expect(BigInt(workspaceSkillsAfter.rows[0]?.total ?? "0")).toBe(
      BigInt(workspaceSkillsBefore.rows[0]?.total ?? "0") + 1n,
    );
    expect(snapshotTotalSkills).toBe(expectedTotalSkills);
    expect(envelope.data.totalSkills).toMatch(/^(?:0|[1-9][0-9]*)$/u);
    expect(BigInt(envelope.data.agentSkillUses)).toBeGreaterThanOrEqual(
      BigInt(before.agentSkillUses) + 4n,
    );
    expect(envelope.data.generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
  });
});
