import { expect, test, type BrowserContext } from "@playwright/test";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

async function authenticate(context: BrowserContext) {
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

test("@sources replays a create after its refresh fails and rotates the key for a new source", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const suffix = Date.now().toString(36);
  const listPath = `/api/v1/workspaces/${encodeURIComponent(harness.workspaceId)}/sources`;
  const createKeys: string[] = [];
  let failNextList = false;
  await page.route(`**${listPath}`, async (route) => {
    const request = route.request();
    if (request.method() === "POST") {
      createKeys.push(request.headers()["idempotency-key"] ?? "");
      const response = await route.fetch();
      failNextList = createKeys.length === 1;
      await route.fulfill({ response });
      return;
    }
    if (failNextList) {
      failNextList = false;
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          ok: false,
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Sources are temporarily unavailable.",
            requestId: "req_sources_refresh",
          },
        }),
      });
      return;
    }
    await route.continue();
  });
  const sources = async (repository: string) => {
    const response = await page.request.get(`${harness.origin}${listPath}`, {
      headers: { "x-skillplane-workspace-id": harness.workspaceId },
    });
    const body = (await response.json()) as {
      data?: { sources: { repositoryUrl: string }[] };
      sources?: { repositoryUrl: string }[];
    };
    return (body.data?.sources ?? body.sources ?? []).filter(
      (s) => s.repositoryUrl === repository,
    ).length;
  };

  const first = `https://github.com/e2e-owner/replay-${suffix}`;
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/sources`);
  await expect(page.getByRole("heading", { name: "Add source" })).toBeVisible();
  await page.getByLabel("Repository URL").fill(first);
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  // The create committed but the refresh failed; the visible retry must replay it.
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.getByRole("heading", { name: "Source settings" })).toBeVisible();
  expect(await sources(first)).toBe(1);
  expect(createKeys).toHaveLength(2);
  expect(createKeys[1]).toBe(createKeys[0]);

  const second = `https://github.com/e2e-owner/rotated-${suffix}`;
  await page.getByRole("button", { name: "New source" }).click();
  await expect(page.getByRole("heading", { name: "Add source" })).toBeVisible();
  await page.getByLabel("Repository URL").fill(second);
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.getByRole("heading", { name: "Source settings" })).toBeVisible();
  expect(createKeys).toHaveLength(3);
  expect(createKeys[2]).not.toBe(createKeys[0]);
  expect(await sources(second)).toBe(1);
});
