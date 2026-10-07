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
  const stale = page.waitForResponse(
    (response) => new URL(response.url()).searchParams.get("groupId") === withSkill,
  );
  await held[0]?.continue();
  await stale;
  await page.waitForTimeout(500);
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
