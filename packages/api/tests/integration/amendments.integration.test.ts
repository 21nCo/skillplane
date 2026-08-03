import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
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
let editor: TenantFixture;
let viewer: TenantFixture;
let outsider: TenantFixture;
let storage: TestObjectStorage;
let app: ReturnType<typeof createApiApp>;
const suffix = `amendments-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const fixtureNames = {
  owner: `${suffix}-owner`,
  editor: `${suffix}-editor`,
  viewer: `${suffix}-viewer`,
  outsider: `${suffix}-outsider`,
};

function headers(
  actor: TenantFixture,
  idempotencyKey?: string,
  workspaceId = owner.workspaceId,
): Record<string, string> {
  return {
    authorization: `Bearer ${actor.sessionToken}`,
    "x-skillplane-workspace-id": workspaceId,
    "content-type": "application/json",
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

function serviceHeaders(
  credential: string,
  idempotencyKey: string,
): Record<string, string> {
  return {
    authorization: `Bearer ${credential}`,
    "x-skillplane-workspace-id": owner.workspaceId,
    "content-type": "application/json",
    "idempotency-key": idempotencyKey,
  };
}

async function data<T>(response: Response): Promise<T> {
  return ((await response.json()) as { readonly data: T }).data;
}

function learning(sourceContextId?: string) {
  return {
    summary: "Require live review-thread verification",
    observation:
      "A review conclusion missed feedback because cached thread state was used.",
    rationale:
      "The amended instruction requires current unresolved-thread evidence before completion.",
    confidence: "high",
    evidence: [
      {
        kind: "integration",
        reference: "reviewThreads:live",
        description: "The stale and current review states were compared.",
      },
    ],
    validation: [
      {
        kind: "integration",
        status: "passed",
        description: "The amended bundle was canonicalized and retrieved.",
      },
    ],
    ...(sourceContextId ? { sourceContextId } : {}),
    tags: ["review", "evidence"],
    externalReferences: [],
    extra: { learningSource: "agent-run" },
  };
}

function amendmentBody(options: {
  baseVersionId: string;
  expectedSha256: string;
  content: string;
  sourceContextId?: string;
  proposedBump?: "patch" | "minor" | "major";
  forUserId?: string;
}) {
  return {
    baseVersionId: options.baseVersionId,
    proposedBump: options.proposedBump ?? "patch",
    changes: [
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: options.expectedSha256,
        content: options.content,
      },
    ],
    learning: learning(options.sourceContextId),
    caller: {
      agent: "codex-reviewer",
      model: "gpt-5",
      client: "skillplane-mcp",
      runId: `run:${suffix}`,
      sessionId: `session:${suffix}`,
      conversationId: `conversation:${suffix}`,
      ...(options.forUserId ? { forUserId: options.forUserId } : {}),
    },
  };
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, fixtureNames.owner);
  editor = await seedTenantFixture(databaseUrl, fixtureNames.editor);
  viewer = await seedTenantFixture(databaseUrl, fixtureNames.viewer);
  outsider = await seedTenantFixture(databaseUrl, fixtureNames.outsider);
  storage = new TestObjectStorage();
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: storage,
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
    requestId: () => `req_amendment_${crypto.randomUUID()}`,
    getServices: async () => services,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  for (const name of Object.values(fixtureNames)) {
    await purgeTenantFixture(databaseUrl, name);
  }
});

describe("amendments, learning provenance, policy, and review", () => {
  it("creates idempotent candidates, enforces roles and digests, and publishes safely", async () => {
    const initialMarkdown =
      "# PR review\n\nInspect the source and tests before reporting findings.\n";
    const initialBundle = await createSkillBundleFixture({
      name: "Agent PR review",
      slug: `agent-pr-review-${suffix.split("-").at(-1)}`,
      description: "Review guidance improved by agents",
      tags: ["review"],
      skillMarkdown: initialMarkdown,
    });
    const create = await app.request(`/api/v1/workspaces/${owner.workspaceId}/skills`, {
      method: "POST",
      headers: headers(owner, `create-${suffix}`),
      body: JSON.stringify({
        bundleBase64: Buffer.from(initialBundle).toString("base64"),
        visibility: "workspace",
      }),
    });
    expect(create.status, await create.clone().text()).toBe(201);
    const created = await data<{
      skill: { id: string };
      version: {
        id: string;
        manifest: { files: readonly { path: string; sha256: string }[] };
      };
    }>(create);
    const skillId = created.skill.id;
    const initialSha = created.version.manifest.files.find(
      (file) => file.path === "SKILL.md",
    )?.sha256;
    if (!initialSha) throw new Error("Initial SKILL.md digest was not returned");

    const contextCreate = await app.request(`/api/v1/skills/${skillId}/contexts`, {
      method: "POST",
      headers: headers(editor, `context-${suffix}`),
      body: JSON.stringify({
        slug: "repository",
        name: "Repository",
        type: "repository",
        externalReference: "github:skillplane/test",
        description: "Repository-specific review knowledge",
        metadata: {},
        knowledge: "# Repository\n\nAlways read current review threads.\n",
        learningMetadata: { summary: "Seed repository knowledge" },
      }),
    });
    expect(contextCreate.status).toBe(201);
    const context = await data<{
      context: { id: string; currentKnowledgeRevisionId: string };
      knowledge: { id: string; bodyDigest: string };
    }>(contextCreate);

    const requestedBody = amendmentBody({
      baseVersionId: created.version.id,
      expectedSha256: initialSha,
      content:
        "# PR review\n\nInspect source, tests, and live unresolved review threads before reporting findings.\n",
      sourceContextId: context.context.id,
    });
    const idempotencyKey = `candidate-${suffix}`;
    const candidateResponse = await app.request(
      `/api/v1/skills/${skillId}/amendments`,
      {
        method: "POST",
        headers: headers(editor, idempotencyKey),
        body: JSON.stringify(requestedBody),
      },
    );
    expect(candidateResponse.status, await candidateResponse.clone().text()).toBe(201);
    const candidate = await data<{
      candidate: {
        id: string;
        status: string;
        revision: number;
        learningMetadata: {
          rationale: string;
          sourceContextId: string;
          sourceContextRevisionId: string;
          sourceContextDigest: string;
        };
        callerDeclaration: {
          agent: string;
          model: string;
          forUserId: string;
        };
      };
      review: {
        id: string;
        status: string;
        requestedByActorId: string;
        requestedForUserId: string;
      };
      policyDecision: { outcome: string; reason: string };
      autoPublished: boolean;
    }>(candidateResponse);
    expect(candidate).toMatchObject({
      candidate: {
        status: "pending_review",
        learningMetadata: {
          sourceContextId: context.context.id,
          sourceContextRevisionId: context.knowledge.id,
          sourceContextDigest: context.knowledge.bodyDigest,
        },
        callerDeclaration: {
          agent: "codex-reviewer",
          model: "gpt-5",
          forUserId: editor.userId,
        },
      },
      review: {
        status: "pending",
        requestedByActorId: editor.userId,
        requestedForUserId: editor.userId,
      },
      policyDecision: {
        outcome: "review_required",
        reason: "policy_requires_review",
      },
      autoPublished: false,
    });

    const replay = await app.request(`/api/v1/skills/${skillId}/amendments`, {
      method: "POST",
      headers: headers(editor, idempotencyKey),
      body: JSON.stringify(requestedBody),
    });
    expect(replay.status).toBe(201);
    expect((await data<typeof candidate>(replay)).candidate.id).toBe(
      candidate.candidate.id,
    );

    const changedReplay = await app.request(`/api/v1/skills/${skillId}/amendments`, {
      method: "POST",
      headers: headers(editor, idempotencyKey),
      body: JSON.stringify({
        ...requestedBody,
        proposedBump: "minor",
      }),
    });
    expect(changedReplay.status).toBe(409);
    expect(await changedReplay.text()).toContain("IDEMPOTENCY_KEY_REUSED");

    const beforeDenied = {
      versions: await services.database.pool.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1",
        [skillId],
      ),
      objects: storage.inventory().length,
    };
    const viewerDenied = await app.request(`/api/v1/skills/${skillId}/amendments`, {
      method: "POST",
      headers: headers(viewer, `viewer-${suffix}`),
      body: JSON.stringify(requestedBody),
    });
    expect(viewerDenied.status).toBe(403);
    expect(
      (
        await services.database.pool.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1",
          [skillId],
        )
      ).rows[0]?.count,
    ).toBe(beforeDenied.versions.rows[0]?.count);
    expect(storage.inventory()).toHaveLength(beforeDenied.objects);

    const wrongDigest = await app.request(`/api/v1/skills/${skillId}/amendments`, {
      method: "POST",
      headers: headers(editor, `wrong-digest-${suffix}`),
      body: JSON.stringify(
        amendmentBody({
          baseVersionId: created.version.id,
          expectedSha256: "0".repeat(64),
          content: "# Invalid digest\n",
        }),
      ),
    });
    expect(wrongDigest.status).toBe(409);
    expect(await wrongDigest.text()).toContain("SKILL_VERSION_CONFLICT");

    const wrongContext = await app.request(`/api/v1/skills/${skillId}/amendments`, {
      method: "POST",
      headers: headers(editor, `wrong-context-${suffix}`),
      body: JSON.stringify(
        amendmentBody({
          baseVersionId: created.version.id,
          expectedSha256: initialSha,
          content: "# Wrong context\n",
          sourceContextId: owner.contextId,
        }),
      ),
    });
    expect(wrongContext.status).toBe(404);
    expect(await wrongContext.text()).toContain("CONTEXT_NOT_FOUND");

    const viewerList = await app.request(
      `/api/v1/skills/${skillId}/candidates?status=pending`,
      { headers: headers(viewer) },
    );
    expect(viewerList.status).toBe(200);
    expect(await viewerList.text()).toContain(candidate.review.id);

    const outsiderRead = await app.request(
      `/api/v1/skills/${skillId}/candidates/${candidate.review.id}`,
      { headers: headers(outsider, undefined, outsider.workspaceId) },
    );
    expect(outsiderRead.status).toBe(404);
    expect(await outsiderRead.text()).not.toContain(candidate.candidate.id);

    const viewerDecision = await app.request(
      `/api/v1/skills/${skillId}/reviews/${candidate.review.id}/approve`,
      {
        method: "POST",
        headers: headers(viewer, `viewer-approve-${suffix}`),
        body: JSON.stringify({ reason: "Viewer must not publish." }),
      },
    );
    expect(viewerDecision.status).toBe(403);
    const stillPending = await services.database.pool.query<{
      review_status: string;
      version_status: string;
    }>(
      `SELECT review.status AS review_status, version.status AS version_status
         FROM amendment_reviews review
         JOIN skill_versions version ON version.id = review.proposed_version_id
        WHERE review.id = $1`,
      [candidate.review.id],
    );
    expect(stillPending.rows[0]).toEqual({
      review_status: "pending",
      version_status: "pending_review",
    });

    const approval = await app.request(
      `/api/v1/skills/${skillId}/reviews/${candidate.review.id}/approve`,
      {
        method: "POST",
        headers: headers(owner, `approve-${suffix}`),
        body: JSON.stringify({
          reason:
            "The evidence, context provenance, exact diff, and integration validation are complete.",
        }),
      },
    );
    expect(approval.status, await approval.clone().text()).toBe(200);
    const approved = await data<{
      review: { status: string; decisionReason: string };
      candidate: {
        id: string;
        status: string;
        semanticVersion: string;
        manifest: { files: readonly { path: string; sha256: string }[] };
      };
    }>(approval);
    expect(approved).toMatchObject({
      review: { status: "approved" },
      candidate: { status: "published", semanticVersion: "1.0.1" },
    });

    const persistedReview = await app.request(
      `/api/v1/skills/${skillId}/candidates/${candidate.review.id}`,
      { headers: headers(viewer) },
    );
    expect(persistedReview.status).toBe(200);
    expect((await data<typeof approved>(persistedReview)).review).toMatchObject({
      status: "approved",
      decisionReason:
        "The evidence, context provenance, exact diff, and integration validation are complete.",
    });

    const servicePrincipal = await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/service-principals`,
      {
        method: "POST",
        headers: headers(owner),
        body: JSON.stringify({
          name: `trusted-amender-${suffix}`,
          role: "editor",
          scopes: ["skills:read", "skills:amend"],
          delegatedUserId: owner.userId,
        }),
      },
    );
    expect(servicePrincipal.status).toBe(201);
    const service = await data<{
      credential: string;
      servicePrincipal: { id: string };
    }>(servicePrincipal);

    const policyUpdate = await app.request(
      `/api/v1/skills/${skillId}/amendment-policy`,
      {
        method: "PUT",
        headers: headers(owner, `policy-${suffix}`),
        body: JSON.stringify({
          policy: {
            mode: "trusted_auto_publish",
            rules: [
              {
                credentialId: service.servicePrincipal.id,
                requiredScopes: ["skills:amend"],
                maxBump: "patch",
                allowedContextIds: [context.context.id],
                dailyLimit: 1,
              },
            ],
          },
        }),
      },
    );
    expect(policyUpdate.status, await policyUpdate.clone().text()).toBe(200);

    const currentSha = approved.candidate.manifest.files.find(
      (file) => file.path === "SKILL.md",
    )?.sha256;
    if (!currentSha) throw new Error("Approved SKILL.md digest was not returned");
    const automatic = await app.request(`/api/v1/skills/${skillId}/amendments`, {
      method: "POST",
      headers: serviceHeaders(service.credential, `auto-${suffix}`),
      body: JSON.stringify(
        amendmentBody({
          baseVersionId: approved.candidate.id,
          expectedSha256: currentSha,
          content:
            "# PR review\n\nInspect source, tests, live review threads, and direct-navigation state before reporting findings.\n",
          sourceContextId: context.context.id,
          forUserId: owner.userId,
        }),
      ),
    });
    expect(automatic.status, await automatic.clone().text()).toBe(201);
    const autoPublished = await data<{
      candidate: {
        id: string;
        status: string;
        semanticVersion: string;
        manifest: { files: readonly { path: string; sha256: string }[] };
      };
      review: { status: string; decisionReason: string };
      policyDecision: { outcome: string; matchedRule: number };
      autoPublished: boolean;
    }>(automatic);
    expect(autoPublished).toMatchObject({
      candidate: { status: "published", semanticVersion: "1.0.2" },
      review: {
        status: "approved",
        decisionReason: "Trusted auto-publish policy matched",
      },
      policyDecision: { outcome: "auto_publish", matchedRule: 0 },
      autoPublished: true,
    });

    const versionCount = await services.database.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM skill_versions WHERE skill_id = $1",
      [skillId],
    );
    expect(versionCount.rows[0]?.count).toBe("3");
    const contextAfter = await services.database.pool.query<{
      current_knowledge_revision_id: string;
    }>("SELECT current_knowledge_revision_id FROM skill_contexts WHERE id = $1", [
      context.context.id,
    ]);
    expect(contextAfter.rows[0]?.current_knowledge_revision_id).toBe(
      context.knowledge.id,
    );

    const datafnReviews = await services.datafn.router.handle(
      new Request("http://localhost/datafn/query", {
        method: "POST",
        headers: headers(viewer),
        body: JSON.stringify({
          resource: "amendmentReviews",
          version: 1,
          select: ["id", "skillId", "status", "policyDecision", "reviewedByActorType"],
          limit: 100,
        }),
      }),
    );
    expect(datafnReviews.status, await datafnReviews.clone().text()).toBe(200);
    const serialized = await datafnReviews.text();
    expect(serialized).toContain(candidate.review.id);
    expect(serialized).not.toContain(outsider.skillId);

    const autoSha = autoPublished.candidate.manifest.files.find(
      (file) => file.path === "SKILL.md",
    )?.sha256;
    if (!autoSha) throw new Error("Auto-published SKILL.md digest was not returned");
    const concurrentCandidates: { reviewId: string; versionId: string }[] = [];
    for (const variant of ["one", "two"]) {
      const response = await app.request(`/api/v1/skills/${skillId}/amendments`, {
        method: "POST",
        headers: headers(editor, `concurrent-${variant}-${suffix}`),
        body: JSON.stringify(
          amendmentBody({
            baseVersionId: autoPublished.candidate.id,
            expectedSha256: autoSha,
            content: `# PR review\n\nConcurrent candidate ${variant}.\n`,
          }),
        ),
      });
      expect(response.status, await response.clone().text()).toBe(201);
      const body = await data<{
        review: { id: string };
        candidate: { id: string; status: string };
      }>(response);
      expect(body.candidate.status).toBe("pending_review");
      concurrentCandidates.push({
        reviewId: body.review.id,
        versionId: body.candidate.id,
      });
    }
    const concurrentDecisions = await Promise.all(
      concurrentCandidates.map((entry, index) =>
        app.request(`/api/v1/skills/${skillId}/reviews/${entry.reviewId}/approve`, {
          method: "POST",
          headers: headers(owner, `concurrent-approve-${String(index)}-${suffix}`),
          body: JSON.stringify({
            reason: `Concurrent candidate ${String(index + 1)} was validated.`,
          }),
        }),
      ),
    );
    expect(concurrentDecisions.map((response) => response.status).sort()).toEqual([
      200, 409,
    ]);
    const concurrencyRows = await services.database.pool.query<{
      version_status: string;
      review_status: string;
      semantic_version: string | null;
    }>(
      `SELECT version.status AS version_status, review.status AS review_status,
              version.semantic_version
         FROM amendment_reviews review
         JOIN skill_versions version ON version.id = review.proposed_version_id
        WHERE review.id = ANY($1::text[])
        ORDER BY review.id`,
      [concurrentCandidates.map((entry) => entry.reviewId)],
    );
    expect(
      concurrencyRows.rows.filter(
        (row) =>
          row.version_status === "published" &&
          row.review_status === "approved" &&
          row.semantic_version === "1.0.3",
      ),
    ).toHaveLength(1);
    expect(
      concurrencyRows.rows.filter(
        (row) =>
          row.version_status === "pending_review" &&
          row.review_status === "pending" &&
          row.semantic_version === null,
      ),
    ).toHaveLength(1);
  });
});
