import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
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
  method: "GET" | "POST" | "PUT",
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

// Release a held request and wait until the page has received its body and run
// the resulting task and frame, instead of sleeping for a fixed interval.
async function releaseAndSettle(page: Page, route: Route | undefined): Promise<void> {
  expect(route).toBeDefined();
  const request = route?.request();
  const finished = page.waitForEvent("requestfinished", (r) => r === request);
  await route?.continue();
  await finished;
  await page.evaluate(
    () =>
      new Promise<void>((done) => {
        setTimeout(() => requestAnimationFrame(() => done()), 0);
      }),
  );
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
  await releaseAndSettle(page, held[0]);
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
  await detail.getByRole("button", { name: "Remove member" }).click();
  await expect(detail.getByRole("button", { name: "Remove member" })).toHaveCount(0);
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
  await viewerRow.getByRole("button", { name: "Remove member" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await expect(viewerRow).toHaveCount(0);
  await expect(detail.getByRole("listitem").filter({ hasText: "(owner)" })).toHaveCount(
    1,
  );
});

for (const flow of ["assignment", "save"] as const)
  test(`@groups a ${flow} that completes after navigation does not reselect its group`, async ({
    context,
    page,
  }) => {
    await authenticate(context);
    const { owner, viewer } = await workspaceMembers(page);
    const name = `Superseded ${flow} ${crypto.randomUUID()}`;
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
    await expect(detail.getByRole("heading", { name })).toBeVisible();
    const held: Route[] = [];
    const method = flow === "save" ? "PATCH" : "DELETE";
    await page.route(
      (url) => url.pathname.includes(`/groups/${encodeURIComponent(groupId)}`),
      async (route) => {
        if (route.request().method() === method) held.push(route);
        else await route.continue();
      },
    );
    if (flow === "save") {
      await page.getByLabel("Name").fill(`${name} renamed`);
      await page.getByRole("button", { name: "Save group" }).click();
    } else {
      await detail
        .getByRole("listitem")
        .filter({ hasText: "(viewer)" })
        .getByRole("button", { name: "Remove member" })
        .click();
    }
    await expect.poll(() => held.length).toBe(1);
    await page.getByRole("link", { name: "Skill groups" }).click();
    await expect(page).toHaveURL(`${harness.origin}/${harness.workspaceSlug}/groups`);
    await expect(page.getByRole("heading", { name: "Create group" })).toBeVisible();
    await expect(detail).toBeHidden();
    await releaseAndSettle(page, held[0]);
    await expect(detail).toBeHidden();
    await expect(page.getByRole("heading", { name: "Create group" })).toBeVisible();
  });
