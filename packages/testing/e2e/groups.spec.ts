import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import { createSkillBundleFixture } from "@skillplane/testing";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;

async function authenticate(context: BrowserContext): Promise<void> {
  await context.addCookies([
    {
      name: "__Secure-skillplane.session",
      value: harness.sessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "skillplane.csrf",
      value: harness.csrfToken,
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

async function api<T>(
  page: Page,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  data?: unknown,
): Promise<T> {
  const response = await page.request.fetch(
    `${harness.origin}/api/v1/workspaces/${encodeURIComponent(harness.workspaceId)}${path}`,
    {
      method,
      headers: {
        "x-authfn-csrf": harness.csrfToken,
        "x-skillplane-workspace-id": harness.workspaceId,
        "idempotency-key": crypto.randomUUID(),
        ...(data === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(data === undefined ? {} : { data: JSON.stringify(data) }),
    },
  );
  expect(response.ok(), `${method} ${path}`).toBe(true);
  return ((await response.json()) as { data: T }).data;
}

async function createGroup(page: Page, name: string): Promise<string> {
  return (await api<{ group: { id: string } }>(page, "POST", "/groups", { name })).group
    .id;
}

// Release a held request, then wait for the page's own signal that every
// operation it started (including superseded ones) has finished handling its
// response, instead of inferring completion from network events and frames.
async function release(
  page: Page,
  route: Route | undefined,
  signal: "data-pending-operations" | "data-pending-loads",
  remaining = 0,
): Promise<void> {
  expect(route).toBeDefined();
  await route?.continue();
  await expect(page.locator(`main[${signal}]`)).toHaveAttribute(
    signal,
    String(remaining),
  );
}

async function settled(page: Page): Promise<void> {
  await expect(page.locator("main[data-pending-operations]")).toHaveAttribute(
    "data-pending-operations",
    "0",
  );
}

async function createSkill(page: Page, label: string): Promise<string> {
  const slug = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  const bytes = await createSkillBundleFixture({
    name: `Ungrouped ${slug}`,
    slug,
    description: "A skill that belongs to no group",
    skillMarkdown: "# Ungrouped\n\nNo group.\n",
  });
  return (
    await api<{ skill: { id: string } }>(page, "POST", "/skills", {
      visibility: "private",
      bundleBase64: Buffer.from(bytes).toString("base64"),
    })
  ).skill.id;
}

async function workspaceMembers(page: Page) {
  const { members } = await api<{ members: { userId: string; role: string }[] }>(
    page,
    "GET",
    "/members",
  );
  const owner = members.find((candidate) => candidate.role === "owner")?.userId;
  const viewer = members.find((candidate) => candidate.role === "viewer")?.userId;
  expect(owner && viewer).toBeTruthy();
  return { owner: owner ?? "", viewer: viewer ?? "" };
}

async function addMember(page: Page, groupId: string, userId: string): Promise<void> {
  await api(
    page,
    "PUT",
    `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
  );
}

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@groups catalog ignores a superseded group-filter response", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const withSkill = await createGroup(page, `Catalog stale ${crypto.randomUUID()}`);
  const empty = await createGroup(page, `Catalog empty ${crypto.randomUUID()}`);
  await api(
    page,
    "PUT",
    `/groups/${encodeURIComponent(withSkill)}/skills/${encodeURIComponent(harness.skillId)}`,
  );
  const held: Route[] = [];
  await page.route(
    (url) =>
      url.pathname.endsWith("/skills") && url.searchParams.get("groupId") === withSkill,
    (route) => {
      held.push(route);
    },
  );
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
  const filter = page.getByLabel("Skill group");
  await expect(filter.locator(`option[value="${empty}"]`)).toHaveCount(1);
  await filter.selectOption(withSkill);
  await expect.poll(() => held.length).toBe(1);
  await filter.selectOption(empty);
  await expect(
    page.getByRole("heading", { name: "No skills match these filters" }),
  ).toBeVisible();
  await release(page, held[0], "data-pending-loads");
  await expect(filter).toHaveValue(empty);
  await expect(page.getByRole("region", { name: "Skill inventory" })).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "No skills match these filters" }),
  ).toBeVisible();
});

test("@groups member-filtered list drops a group after that member is removed", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const { members } = await api<{ members: { userId: string; role: string }[] }>(
    page,
    "GET",
    "/members",
  );
  const member = members.find((candidate) => candidate.role === "viewer");
  expect(member).toBeDefined();
  const userId = member?.userId ?? "";
  const name = `Member filter ${crypto.randomUUID()}`;
  const groupId = await createGroup(page, name);
  await api(
    page,
    "PUT",
    `/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`,
  );
  await page.goto(
    `${harness.origin}/${harness.workspaceSlug}/groups?memberId=${encodeURIComponent(userId)}`,
  );
  const nav = page.getByRole("navigation", { name: "Skill groups" });
  await nav.getByRole("button", { name }).click();
  const detail = page.getByRole("region", { name: "Group detail" });
  const row = detail.getByRole("listitem").filter({ hasText: "(viewer)" });
  await row.getByRole("button", { name: /^Remove / }).click();
  await expect(row).toHaveCount(0);
  await expect(nav.getByRole("button", { name })).toHaveCount(0);
});

test("@groups a created group never shows the previous group's assignments", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const previous = `Previous ${crypto.randomUUID()}`;
  const previousId = await createGroup(page, previous);
  await api(
    page,
    "PUT",
    `/groups/${encodeURIComponent(previousId)}/skills/${encodeURIComponent(harness.skillId)}`,
  );
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/groups`);
  await page
    .getByRole("navigation", { name: "Skill groups" })
    .getByRole("button", { name: previous })
    .click();
  const detail = page.getByRole("region", { name: "Group detail" });
  await expect(detail.getByRole("button", { name: /^Remove / })).toHaveCount(1);
  await page.getByRole("button", { name: "New group" }).click();
  const created = `Created ${crypto.randomUUID()}`;
  await page.getByLabel("Name").fill(created);
  let failList = true;
  await page.route(
    (url) => url.pathname.endsWith("/groups") && url.searchParams.has("state"),
    async (route) => {
      if (!failList || route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      failList = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "Group list unavailable" },
        }),
      });
    },
  );
  await page.getByRole("button", { name: "Save group" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(detail.getByRole("heading", { name: created })).toBeVisible();
  await expect(detail.getByRole("button", { name: /^Remove / })).toHaveCount(0);
});

test("@groups a failed list refresh still refreshes the group detail after a member change", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const { owner, viewer } = await workspaceMembers(page);
  const name = `Refresh both ${crypto.randomUUID()}`;
  const groupId = await createGroup(page, name);
  await addMember(page, groupId, owner);
  await addMember(page, groupId, viewer);
  await page.goto(
    `${harness.origin}/${harness.workspaceSlug}/groups?memberId=${encodeURIComponent(owner)}`,
  );
  await page
    .getByRole("navigation", { name: "Skill groups" })
    .getByRole("button", { name })
    .click();
  const detail = page.getByRole("region", { name: "Group detail" });
  const viewerRow = detail.getByRole("listitem").filter({ hasText: "(viewer)" });
  await expect(viewerRow).toHaveCount(1);
  await page.route(
    (url) => url.pathname.endsWith("/groups") && url.searchParams.has("state"),
    (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "UNAVAILABLE", message: "Group list unavailable" },
        }),
      }),
  );
  await viewerRow.getByRole("button", { name: /^Remove / }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(viewerRow).toHaveCount(0);
  await expect(detail.getByRole("listitem").filter({ hasText: "(owner)" })).toHaveCount(
    1,
  );
});

for (const flow of ["assignment", "save"] as const)
  test(`@groups a ${flow} held across away-and-back navigation leaves the newer view alone`, async ({
    context,
    page,
  }) => {
    await authenticate(context);
    const { owner, viewer } = await workspaceMembers(page);
    const name = `Superseded ${flow} ${crypto.randomUUID()}`;
    const groupId = await createGroup(page, name);
    await addMember(page, groupId, owner);
    await addMember(page, groupId, viewer);
    const filtered = `${harness.origin}/${harness.workspaceSlug}/groups?memberId=${encodeURIComponent(owner)}`;
    await page.goto(filtered);
    const nav = page.getByRole("navigation", { name: "Skill groups" });
    const detail = page.getByRole("region", { name: "Group detail" });
    await nav.getByRole("button", { name }).click();
    await expect(detail.getByRole("heading", { name })).toBeVisible();
    await settled(page);
    const held: Route[] = [];
    const method = flow === "save" ? "PATCH" : "DELETE";
    await page.route(
      (url) => url.pathname.includes(`/groups/${encodeURIComponent(groupId)}`),
      async (route) => {
        if (route.request().method() === method) held.push(route);
        else await route.continue();
      },
    );
    const viewerRow = detail.getByRole("listitem").filter({ hasText: "(viewer)" });
    const start = async (draft: string) => {
      if (flow === "save") {
        await page.getByLabel("Name").fill(draft);
        await page.getByRole("button", { name: "Save group" }).click();
      } else {
        await viewerRow.getByRole("button", { name: /^Remove / }).click();
      }
    };
    await start(`${name} stale`);
    await expect.poll(() => held.length).toBe(1);
    // Leave the filtered view, then return to the same filter: the navigation keys
    // repeat, but the held continuation belongs to an older navigation.
    await page.getByRole("link", { name: "Skill groups" }).click();
    await expect(page).toHaveURL(`${harness.origin}/${harness.workspaceSlug}/groups`);
    await page.goBack();
    await expect(page).toHaveURL(filtered);
    await expect(page.getByRole("heading", { name: "Create group" })).toBeVisible();
    await nav.getByRole("button", { name }).click();
    await expect(detail.getByRole("heading", { name })).toBeVisible();
    await expect(page.locator("main[data-pending-operations]")).toHaveAttribute(
      "data-pending-operations",
      "1",
    );
    const newer = `${name} newer`;
    await start(newer);
    await expect.poll(() => held.length).toBe(2);
    // The stale save answers with a successful body without reaching the server,
    // so the newer save still matches the stored revision.
    if (flow === "save")
      await held[0]?.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          data: {
            group: {
              id: groupId,
              workspaceId: harness.workspaceId,
              name: `${name} stale`,
              description: "",
              revision: 2,
              archivedAt: null,
            },
          },
        }),
      });
    else await held[0]?.continue();
    await expect(page.locator("main[data-pending-operations]")).toHaveAttribute(
      "data-pending-operations",
      "1",
    );
    // The stale continuation neither reselects, rewrites the form, nor ends the
    // newer operation's busy state.
    await expect(
      nav.getByRole("button", { name: /^Superseded / }).first(),
    ).toBeDisabled();
    if (flow === "save") await expect(page.getByLabel("Name")).toHaveValue(newer);
    await expect(detail.getByRole("heading", { name })).toBeVisible();
    await release(page, held[1], "data-pending-operations");
    if (flow === "save") {
      await expect(detail.getByRole("heading", { name: newer })).toBeVisible();
      await expect(page.getByLabel("Name")).toHaveValue(newer);
    } else {
      await expect(viewerRow).toHaveCount(0);
      await expect(
        detail.getByRole("listitem").filter({ hasText: "(owner)" }),
      ).toHaveCount(1);
    }
    await expect(page.getByRole("alert")).toHaveCount(0);
  });

test("@groups a partial detail failure keeps the view busy until every response settles", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const { owner } = await workspaceMembers(page);
  const name = `Partial ${crypto.randomUUID()}`;
  const groupId = await createGroup(page, name);
  await api(
    page,
    "PUT",
    `/groups/${encodeURIComponent(groupId)}/skills/${encodeURIComponent(harness.skillId)}`,
  );
  await addMember(page, groupId, owner);
  const heldSkills: Route[] = [];
  let failMembers = true;
  await page.route(
    (url) =>
      url.pathname.startsWith(`/api/v1/workspaces/`) &&
      url.pathname.includes(`/groups/${encodeURIComponent(groupId)}/`),
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith("/skills") && !heldSkills.length) {
        heldSkills.push(route);
        return;
      }
      if (path.endsWith("/members") && failMembers) {
        failMembers = false;
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "UNAVAILABLE", message: "Members unavailable" },
          }),
        });
        return;
      }
      await route.continue();
    },
  );
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/groups`);
  const button = page
    .getByRole("navigation", { name: "Skill groups" })
    .getByRole("button", { name });
  const failed = page.waitForResponse(
    (response) => response.url().includes("/members") && response.status() === 503,
  );
  await button.click();
  await failed;
  await expect.poll(() => heldSkills.length).toBe(1);
  // The members failure must not release the view while the skills response is
  // still outstanding, so the same group cannot be reselected underneath it.
  await expect(button).toBeDisabled();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await release(page, heldSkills[0], "data-pending-operations");
  await expect(page.getByRole("alert")).toContainText("Members unavailable");
  await expect(button).toBeEnabled();
  await button.click();
  await settled(page);
  const detail = page.getByRole("region", { name: "Group detail" });
  await expect(detail.getByRole("listitem").filter({ hasText: "(owner)" })).toHaveCount(
    1,
  );
  await expect(detail.getByRole("button", { name: /^Remove PR Review / })).toHaveCount(
    1,
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("@groups assignment changes keep an unsaved name and description draft", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const name = `Draft ${crypto.randomUUID()}`;
  const groupId = await createGroup(page, name);
  await api(
    page,
    "PUT",
    `/groups/${encodeURIComponent(groupId)}/skills/${encodeURIComponent(harness.skillId)}`,
  );
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/groups`);
  await page
    .getByRole("navigation", { name: "Skill groups" })
    .getByRole("button", { name })
    .click();
  await settled(page);
  const detail = page.getByRole("region", { name: "Group detail" });
  await page.getByLabel("Name").fill(`${name} draft`);
  await page.getByLabel("Description").fill("Unsaved description");
  await detail.getByRole("button", { name: /^Remove PR Review / }).click();
  await settled(page);
  await expect(detail.getByRole("button", { name: /^Remove PR Review / })).toHaveCount(
    0,
  );
  await expect(page.getByLabel("Name")).toHaveValue(`${name} draft`);
  await expect(page.getByLabel("Description")).toHaveValue("Unsaved description");
  await detail.getByLabel("Skill", { exact: true }).selectOption(harness.skillId);
  await detail.getByRole("button", { name: "Add skill" }).click();
  await settled(page);
  await expect(detail.getByRole("button", { name: /^Remove PR Review / })).toHaveCount(
    1,
  );
  await expect(page.getByLabel("Name")).toHaveValue(`${name} draft`);
  await expect(page.getByLabel("Description")).toHaveValue("Unsaved description");
});

test("@groups catalog rows show every group of a skill from one bulk request", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const first = `Badge one ${crypto.randomUUID().slice(0, 8)}`;
  const second = `Badge two ${crypto.randomUUID().slice(0, 8)}`;
  for (const groupName of [first, second])
    await api(
      page,
      "PUT",
      `/groups/${encodeURIComponent(await createGroup(page, groupName))}/skills/${encodeURIComponent(harness.skillId)}`,
    );
  const ungrouped = await createSkill(page, "ungrouped");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/groups/skill-assignments"))
      requests.push(request.url());
  });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
  const inventory = page.getByRole("region", { name: "Skill inventory" });
  const grouped = inventory.getByRole("article").filter({ hasText: "PR Review" });
  await expect(grouped.getByText(first, { exact: true })).toBeVisible();
  await expect(grouped.getByText(second, { exact: true })).toBeVisible();
  const plain = inventory.getByRole("article").filter({ hasText: "Ungrouped" });
  await expect(plain).toHaveCount(1);
  await expect(plain.getByText("Groups:")).toHaveCount(0);
  expect(requests).toHaveLength(1);
  const url = new URL(requests[0] ?? "");
  expect(url.searchParams.getAll("skillId")).toEqual(
    expect.arrayContaining([harness.skillId, ungrouped]),
  );
});
