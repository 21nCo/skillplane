import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createSkill,
  listSkills,
  getSkill,
  getSkillBySlug,
  getSkillVersion,
} from "../../src/lib/skills/api.js";

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
      sort: ["-updatedAt", "id"],
      limit: 20,
    });

    await listSkills({
      workspaceId: "workspace:india",
      archive: "active",
      cursor: page.nextCursor,
      visibility: ["workspace"],
      limit: 20,
    });
    const nextQuery = await requestDetails(fetchMock.mock.calls[1] ?? []);
    expect(nextQuery.body.cursor).toEqual({
      after: { updatedAt: skill.updatedAt, id: skill.id },
    });
  });

  it("retains domain search ranking and forwards its cursor unchanged", async () => {
    const page = {
      skills: [{ ...skill, workspaceId: "workspace:india" }],
      nextCursor: "signed-domain-cursor",
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({ ok: true, data: page, meta: { requestId: "r" } }),
            { headers: { "content-type": "application/json" } },
          ),
      );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      workspaceId: "workspace:india",
      query: "published-only-term",
      visibility: ["workspace"] as const,
      archive: "active" as const,
    };
    const first = await listSkills(options);
    expect(first.skills).toEqual(page.skills);
    await listSkills({ ...options, cursor: first.nextCursor });
    const url = new URL(
      String(fetchMock.mock.calls[1]?.[0]),
      "https://app.skillplane.dev",
    );
    expect(url.pathname).toBe("/api/v1/workspaces/workspace%3Aindia/skills");
    expect(url.searchParams.get("q")).toBe("published-only-term");
    expect(url.searchParams.get("cursor")).toBe("signed-domain-cursor");
    expect(url.searchParams.getAll("visibility")).toEqual(["workspace"]);
    expect(
      new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get(
        "x-skillplane-workspace-id",
      ),
    ).toBe("workspace:india");
    await expect(
      listSkills({ ...options, query: "another", cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "CURSOR_FILTER_MISMATCH" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each([
    { workspaceId: "workspace:other" },
    { query: "new search" },
    { archive: "archived" as const },
    { visibility: ["private"] as const },
  ])("rejects cursor reuse with changed scope %j before transport", async (changed) => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      datafnResponse([skill], {
        after: { updatedAt: skill.updatedAt, id: skill.id },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const options = {
      workspaceId: "workspace:india",
      visibility: ["workspace"] as const,
    };
    const first = await listSkills(options);
    await expect(
      listSkills({ ...options, ...changed, cursor: first.nextCursor }),
    ).rejects.toMatchObject({ code: "CURSOR_FILTER_MISMATCH", status: 400 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("normalizes visibility order and allows page-size changes", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockImplementation(async () =>
      datafnResponse([skill], {
        after: { updatedAt: skill.updatedAt, id: skill.id },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const first = await listSkills({
      workspaceId: "workspace:india",
      visibility: ["workspace", "private"],
    });
    await listSkills({
      workspaceId: "workspace:india",
      visibility: ["private", "workspace", "private"],
      limit: 10,
      cursor: first.nextCursor,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserves authenticated archived detail reads by ID and slug", async () => {
    const archivedAt = "2026-09-01T00:00:00.000Z";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => datafnResponse([{ ...skill, archivedAt }]));
    vi.stubGlobal("fetch", fetchMock);
    expect((await getSkill("workspace:india", skill.id)).archivedAt).toBe(archivedAt);
    expect((await getSkillBySlug("workspace:india", skill.slug)).archivedAt).toBe(
      archivedAt,
    );
    expect((await requestDetails(fetchMock.mock.calls[0] ?? [])).body.filters).toEqual({
      id: skill.id,
    });
    expect((await requestDetails(fetchMock.mock.calls[1] ?? [])).body.filters).toEqual({
      slug: skill.slug,
    });
  });

  it("distinguishes missing versions from missing skills", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>().mockImplementation(async () => datafnResponse([])),
    );
    await expect(
      getSkillVersion("workspace:india", skill.id, "version:missing"),
    ).rejects.toMatchObject({
      status: 404,
      code: "SKILL_VERSION_NOT_FOUND",
      message: "Skill version was not found",
    });
    await expect(getSkill("workspace:india", "skill:missing")).rejects.toMatchObject({
      status: 404,
      code: "SKILL_NOT_FOUND",
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
