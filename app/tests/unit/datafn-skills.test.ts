import { afterEach, describe, expect, it, vi } from "vitest";
import { createSkill, listSkills } from "../../src/lib/skills/api.js";

const skill = {
  id: "skill:one",
  slug: "latency-review",
  name: "Latency review",
  description: "Trace a regional request",
  tags: ["performance"],
  visibility: "workspace",
  amendmentPolicy: { mode: "review_required" },
  currentPublishedVersionId: "version:one",
  archivedAt: null,
  createdAt: "2026-08-31T10:00:00.000Z",
  updatedAt: "2026-08-31T11:00:00.000Z",
};

const version = {
  id: "version:one",
  skillId: "skill:one",
  revision: 1,
  semanticVersion: "1.0.0",
  status: "published",
  baseVersionId: null,
  proposedBump: null,
  source: "human",
  contentDigest: `sha256:${"1".repeat(64)}`,
  bundleByteSize: 42,
  manifest: { formatVersion: 1, digest: `sha256:${"1".repeat(64)}`, files: [] },
  learningMetadata: {},
  amendmentOperations: [],
  callerDeclaration: {},
  policyDecision: {},
  changeSummary: "Initial version",
  createdByActorType: "user",
  createdByActorId: "user:one",
  createdByAgent: null,
  createdByModel: null,
  createdForUserId: null,
  publishedAt: "2026-08-31T10:00:00.000Z",
  createdAt: "2026-08-31T10:00:00.000Z",
};

function datafnResponse(data: readonly unknown[], nextCursor: unknown = null) {
  return new Response(JSON.stringify({ ok: true, result: { data, nextCursor } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function requestDetails(call: readonly unknown[]) {
  const [input, init] = call as [RequestInfo | URL, RequestInit | undefined];
  const request =
    input instanceof Request
      ? input
      : new Request(new URL(String(input), "https://app.skillplane.dev"), init);
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: (await request.clone().json()) as Record<string, unknown>,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first-party DataFn skill reads", () => {
  it("queries the active workspace through the real DataFn HTTP transport", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        datafnResponse([{ ...skill, currentVersion: version }], {
          after: { updatedAt: skill.updatedAt, id: skill.id },
        }),
      )
      .mockResolvedValueOnce(datafnResponse([]));
    vi.stubGlobal("fetch", fetchMock);

    const page = await listSkills({
      workspaceId: "workspace:india",
      query: "latency",
      visibility: ["workspace"],
      archive: "active",
      limit: 20,
    });

    expect(page).toMatchObject({
      skills: [
        {
          id: "skill:one",
          workspaceId: "workspace:india",
          currentSemanticVersion: "1.0.0",
        },
      ],
    });
    expect(page.nextCursor).toEqual(expect.any(String));
    expect(fetchMock).toHaveBeenCalledOnce();
    const query = await requestDetails(fetchMock.mock.calls[0] ?? []);
    expect(query.url.endsWith("/datafn/query")).toBe(true);
    expect(query.method).toBe("POST");
    expect(query.headers.get("x-skillplane-workspace-id")).toBe("workspace:india");
    expect(query.body).toMatchObject({
      resource: "skills",
      filters: {
        archivedAt: { is_null: true },
        visibility: { in: ["workspace"] },
      },
      search: { query: "latency", prefix: true },
      sort: ["-updatedAt", "id"],
      limit: 20,
    });

    await listSkills({
      workspaceId: "workspace:india",
      archive: "active",
      cursor: page.nextCursor,
      limit: 20,
    });
    const nextQuery = await requestDetails(fetchMock.mock.calls[1] ?? []);
    expect(nextQuery.body.cursor).toEqual({
      after: { updatedAt: skill.updatedAt, id: skill.id },
    });
  });

  it("keeps invariant-heavy skill creation on the Hono command API", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, data: {}, meta: { requestId: "r" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await createSkill({
      workspaceId: "workspace:india",
      bundleBase64: "UEsDBA==",
      visibility: "private",
      idempotencyKey: "create:one",
    });

    const [input, init] = fetchMock.mock.calls[0] ?? [];
    expect(input).toBe("/api/v1/workspaces/workspace%3Aindia/skills");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("idempotency-key")).toBe("create:one");
  });

  it("rejects malformed opaque cursors before sending a query", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      listSkills({
        workspaceId: "workspace:india",
        cursor: "not-a-datafn-cursor",
      }),
    ).rejects.toMatchObject({ code: "CURSOR_INVALID", status: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
