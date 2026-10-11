import { afterAll, beforeAll, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  createSkillBundleFixture,
  seedTenantFixture,
  purgeTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
const suffixes = [
  `groups-http-${crypto.randomUUID()}`,
  `groups-out-${crypto.randomUUID()}`,
] as const;
const roleSuffixes = {
  viewer: `groups-viewer-${crypto.randomUUID()}`,
  editor: `groups-editor-${crypto.randomUUID()}`,
} as const;
let databaseUrl: string;
let services: ApiServices, owner: TenantFixture, outsider: TenantFixture;
const members: Partial<Record<keyof typeof roleSuffixes, TenantFixture>> = {};
let app: ReturnType<typeof createApiApp>;
beforeAll(async () => {
  const url = await resolveTestDatabaseUrl();
  databaseUrl = url;
  await migrateDatabase(url);
  owner = await seedTenantFixture(url, suffixes[0]);
  outsider = await seedTenantFixture(url, suffixes[1]);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: url,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  app = createApiApp({ getServices: async () => services });
  // Sessions for viewer and editor members of the owner's workspace.
  for (const role of ["viewer", "editor"] as const) {
    const fixture = await seedTenantFixture(url, roleSuffixes[role]);
    await services.database.pool.query(
      "INSERT INTO workspace_memberships(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)",
      [
        `membership:${roleSuffixes[role]}:owner-workspace`,
        owner.workspaceId,
        fixture.userId,
        role,
      ],
    );
    members[role] = fixture;
  }
});
afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  for (const suffix of [...suffixes, ...Object.values(roleSuffixes)])
    await purgeTenantFixture(databaseUrl, suffix);
});
it("routes lifecycle and assignments through authenticated workspace scope", async () => {
  const headers = {
    authorization: `Bearer ${owner.sessionToken}`,
    "content-type": "application/json",
    "idempotency-key": crypto.randomUUID(),
    "x-skillplane-workspace-id": owner.workspaceId,
  };
  const base = `/api/v1/workspaces/${owner.workspaceId}/groups`;
  expect((await app.request(base)).status).toBe(401);
  expect(
    (
      await app.request(base, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: "Design" }),
      })
    ).status,
  ).toBe(201);
  const list = await app.request(base, { headers });
  expect(list.status).toBe(200);
  const body = (await list.json()) as { data: { groups: { id: string }[] } };
  const id = body.data.groups[0]?.id ?? "";
  expect(id).toBeTruthy();
  expect(
    (
      await app.request(`${base}/${id}/skills/${owner.skillId}`, {
        method: "PUT",
        headers,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`${base}/${id}/members/${owner.userId}`, {
        method: "PUT",
        headers,
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await app.request(`${base}/${id}/skills/${outsider.skillId}`, {
        method: "PUT",
        headers,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await app.request(`${base}/${id}`, {
        headers: { authorization: `Bearer ${outsider.sessionToken}` },
      })
    ).status,
  ).toBe(404);
  const patch = await app.request(`${base}/${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      name: "Design systems",
      description: "Reusable design work",
      archived: true,
      expectedRevision: 1,
    }),
  });
  expect(patch.status).toBe(200);
  const assignments = await app.request(`${base}/${id}/skills`, { headers });
  expect(assignments.status).toBe(200);
  expect(
    ((await assignments.json()) as { data: { skills: { id: string }[] } }).data
      .skills[0]?.id,
  ).toBe(owner.skillId);
  expect((await app.request(`${base}?state=unsupported`, { headers })).status).toBe(
    400,
  );
  const filtered = await app.request(
    `/api/v1/workspaces/${owner.workspaceId}/skills?groupId=${encodeURIComponent(id)}`,
    { headers },
  );
  expect(filtered.status).toBe(200);
  expect(
    ((await filtered.json()) as { data: { skills: unknown[] } }).data.skills,
  ).toEqual([]);
  const padded = await app.request(
    `${base}?state=all&userId=${encodeURIComponent(` ${owner.userId} `)}`,
    { headers },
  );
  expect(padded.status).toBe(200);
  expect(
    ((await padded.json()) as { data: { groups: { id: string }[] } }).data.groups.map(
      (group) => group.id,
    ),
  ).toContain(id);
  for (const path of [
    `/api/v1/workspaces/${owner.workspaceId}/skills?groupId=`,
    `/api/v1/workspaces/${owner.workspaceId}/skills?q=design&groupId=`,
    `${base}?userId=`,
    `${base}?skillId=`,
    `${base}?skillId=%20%20`,
  ]) {
    const response = await app.request(path, { headers });
    expect(response.status, path).toBe(400);
    expect(await response.json(), path).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  }
});

function sessionHeaders(tenant: TenantFixture, extra: Record<string, string> = {}) {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": owner.workspaceId,
    ...extra,
  };
}
async function data<T>(response: Response, label = ""): Promise<T> {
  expect(response.status, label).toBeLessThan(300);
  return ((await response.json()) as { data: T }).data;
}
async function createGroup(name: string) {
  return (
    await data<{ group: { id: string; revision: number } }>(
      await app.request(`/api/v1/workspaces/${owner.workspaceId}/groups`, {
        method: "POST",
        headers: sessionHeaders(owner, {
          "content-type": "application/json",
          "idempotency-key": crypto.randomUUID(),
        }),
        body: JSON.stringify({ name }),
      }),
    )
  ).group;
}
async function assignSkill(groupId: string, skillId: string) {
  await data(
    await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/groups/${encodeURIComponent(groupId)}/skills/${encodeURIComponent(skillId)}`,
      { method: "PUT", headers: sessionHeaders(owner) },
    ),
  );
}
async function createSkill(slug: string, visibility: string, archived = false) {
  const bundle = await createSkillBundleFixture({
    name: `Harbor ${slug}`,
    slug,
    description: "Harbor operations guidance",
    tags: ["harbor"],
    skillMarkdown: "# Harbor\n\nHarbor operations guidance.\n",
  });
  const { skill } = await data<{ skill: { id: string } }>(
    await app.request(`/api/v1/workspaces/${owner.workspaceId}/skills`, {
      method: "POST",
      headers: sessionHeaders(owner, {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      }),
      body: JSON.stringify({
        visibility,
        bundleBase64: Buffer.from(bundle).toString("base64"),
      }),
    }),
    slug,
  );
  if (archived)
    await data(
      await app.request(`/api/v1/skills/${encodeURIComponent(skill.id)}/archive`, {
        method: "POST",
        headers: sessionHeaders(owner, { "idempotency-key": crypto.randomUUID() }),
      }),
      `archive ${slug}`,
    );
  return skill.id;
}

it("rejects group writes from viewers, editors and service credentials over HTTP", async () => {
  const group = await createGroup(`Writes ${crypto.randomUUID()}`);
  const base = `/api/v1/workspaces/${owner.workspaceId}/groups`;
  const writes = (headers: Record<string, string>) => [
    app.request(base, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: `Denied ${crypto.randomUUID()}` }),
    }),
    app.request(`${base}/${encodeURIComponent(group.id)}`, {
      method: "PATCH",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "Denied", archived: true, expectedRevision: 1 }),
    }),
    app.request(
      `${base}/${encodeURIComponent(group.id)}/skills/${encodeURIComponent(owner.skillId)}`,
      { method: "PUT", headers },
    ),
    app.request(
      `${base}/${encodeURIComponent(group.id)}/members/${encodeURIComponent(owner.userId)}`,
      { method: "PUT", headers },
    ),
  ];
  for (const role of ["viewer", "editor"] as const) {
    const tenant = members[role];
    if (!tenant) throw new Error(`${role} fixture missing`);
    const headers = sessionHeaders(tenant, { "idempotency-key": crypto.randomUUID() });
    for (const response of await Promise.all(writes(headers))) {
      expect(response.status, role).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: "WORKSPACE_FORBIDDEN" },
      });
    }
    // Reading groups stays available to every workspace member.
    expect((await app.request(base, { headers })).status, role).toBe(200);
  }
  const created = await data<{ credential: string }>(
    await app.request(`/api/v1/workspaces/${owner.workspaceId}/service-principals`, {
      method: "POST",
      headers: sessionHeaders(owner, { "content-type": "application/json" }),
      body: JSON.stringify({
        name: `groups-agent-${crypto.randomUUID().slice(0, 8)}`,
        role: "admin",
        scopes: ["skills:read", "skills:write"],
      }),
    }),
    "service principal",
  );
  const service = {
    authorization: `Bearer ${created.credential}`,
    "x-skillplane-workspace-id": owner.workspaceId,
    "idempotency-key": crypto.randomUUID(),
  };
  // The workspace route tree, groups included, accepts only human sessions.
  for (const response of await Promise.all(writes(service)))
    expect(response.status).toBe(401);
  for (const path of [
    base,
    `${base}/${encodeURIComponent(group.id)}`,
    `${base}/${encodeURIComponent(group.id)}/members`,
  ])
    expect((await app.request(path, { headers: service })).status, path).toBe(401);
  // A credential with skills:read can still filter search by a group id.
  const serviceSearch = async () =>
    (
      await data<{ skills: { id: string }[] }>(
        await app.request(
          `/api/v1/skills/search?q=review&groupId=${encodeURIComponent(group.id)}`,
          { headers: service },
        ),
        "service search",
      )
    ).skills.map((skill) => skill.id);
  expect(await serviceSearch()).toEqual([]);
  await assignSkill(group.id, owner.skillId);
  expect(await serviceSearch()).toEqual([owner.skillId]);
  const audit = await services.database.pool.query(
    "SELECT event_type FROM audit_events WHERE workspace_id=$1 AND resource_id=$2",
    [owner.workspaceId, group.id],
  );
  expect(audit.rows.map((row) => row.event_type).sort()).toEqual([
    "skill_group.created",
    "skill_group.skill.added",
  ]);
});

it("filters skill list and search by group with visibility, archive and cursor", async () => {
  const tag = crypto.randomUUID().slice(0, 8);
  const grouped = await createSkill(`harbor-a-${tag}`, "private");
  const groupedPublic = await createSkill(`harbor-b-${tag}`, "public");
  const ungrouped = await createSkill(`harbor-c-${tag}`, "private");
  const groupedArchived = await createSkill(`harbor-d-${tag}`, "private", true);
  const group = await createGroup(`Harbor ${tag}`);
  const second = await createGroup(`Harbor second ${tag}`);
  for (const id of [grouped, groupedPublic, groupedArchived])
    await assignSkill(group.id, id);
  await assignSkill(second.id, grouped);
  const headers = sessionHeaders(owner);
  const list = `/api/v1/workspaces/${owner.workspaceId}/skills`;
  const search = `/api/v1/skills/search?workspaceId=${encodeURIComponent(owner.workspaceId)}`;
  const g = `groupId=${encodeURIComponent(group.id)}`;
  async function ids(path: string) {
    const all: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { skills: { id: string }[]; nextCursor: string | null } = await data(
        await app.request(
          `${path}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          { headers },
        ),
        path,
      );
      all.push(...page.skills.map((skill) => skill.id));
      cursor = page.nextCursor;
    } while (cursor);
    return all.sort();
  }
  const sorted = (...values: string[]) => [...values].sort();
  for (const [label, path] of [
    ["list", `${list}?q=harbor&`],
    ["list without query", `${list}?`],
    ["search", `${search}&q=harbor&`],
  ] as const) {
    const scoped = (filters: string) => ids(`${path}${filters}&limit=1`);
    if (label !== "list without query")
      expect(await scoped("state=active"), label).toEqual(
        expect.arrayContaining([grouped, groupedPublic, ungrouped]),
      );
    expect(await scoped(g), label).toEqual(sorted(grouped, groupedPublic));
    expect(await scoped(`${g}&visibility=public`), label).toEqual([groupedPublic]);
    expect(await scoped(`${g}&state=archived`), label).toEqual([groupedArchived]);
    expect(await scoped(`${g}&state=all`), label).toEqual(
      sorted(grouped, groupedPublic, groupedArchived),
    );
    // A cursor is bound to its group filter.
    const first: { nextCursor: string | null } = await data(
      await app.request(`${path}${g}&limit=1`, { headers }),
    );
    expect(first.nextCursor, label).toBeTruthy();
    const mismatch = await app.request(
      `${path}groupId=${encodeURIComponent(second.id)}&limit=1&cursor=${encodeURIComponent(first.nextCursor ?? "")}`,
      { headers },
    );
    expect(mismatch.status, label).toBe(400);
  }
  for (const path of [`${search}&q=harbor&groupId=`, `${search}&groupId=%20`]) {
    const response = await app.request(path, { headers });
    expect(response.status, path).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: "VALIDATION_FAILED" },
    });
  }
  const badges = await data<{
    skills: { skillId: string; groups: { id: string }[] }[];
  }>(
    await app.request(
      `/api/v1/workspaces/${owner.workspaceId}/groups/skill-assignments?skillId=${encodeURIComponent(grouped)}&skillId=${encodeURIComponent(ungrouped)}`,
      { headers },
    ),
  );
  expect(
    badges.skills.map((entry) => [
      entry.skillId,
      entry.groups.map((item) => item.id).sort(),
    ]),
  ).toEqual([
    [grouped, sorted(group.id, second.id)],
    [ungrouped, []],
  ]);
});
