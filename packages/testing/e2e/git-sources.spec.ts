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
  await harness?.close();
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

test("@sources keeps settings edited while a save is in flight", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const listPath = `/api/v1/workspaces/${encodeURIComponent(harness.workspaceId)}/sources`;
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  let patched: (() => void) | undefined;
  const patchSeen = new Promise<void>((resolve) => (patched = resolve));
  await page.route(`**${listPath}/*`, async (route) => {
    if (route.request().method() !== "PATCH") return route.continue();
    patched?.();
    await held;
    await route.continue();
  });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/sources`);
  await page
    .getByLabel("Repository URL")
    .fill(`https://github.com/e2e-owner/draft-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.getByRole("heading", { name: "Source settings" })).toBeVisible();
  const refInput = page.getByLabel("Branch, tag, or commit");
  await refInput.fill("release-1");
  await page.getByRole("button", { name: "Save source" }).click();
  await patchSeen;
  // The user keeps typing after submitting; the refresh must not discard it.
  await refInput.fill("release-2");
  release();
  await expect(page.getByText("· track · release-1")).toBeVisible();
  await expect(page.getByRole("button", { name: "Save source" })).toBeEnabled();
  await expect(refInput).toHaveValue("release-2");
});

test("@sources a draft typed while switching sources is not carried to the new source", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const suffix = Date.now().toString(36);
  const listPath = `/api/v1/workspaces/${encodeURIComponent(harness.workspaceId)}/sources`;
  let hold = false,
    release: () => void = () => undefined,
    requested: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const detailSeen = new Promise<void>((resolve) => (requested = resolve));
  const patches: { ref?: string }[] = [];
  await page.route(`**${listPath}/*`, async (route) => {
    const request = route.request();
    if (request.method() === "PATCH")
      patches.push(request.postDataJSON() as { ref?: string });
    if (request.method() === "GET" && hold) {
      hold = false;
      requested();
      await held;
    }
    await route.continue();
  });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/sources`);
  for (const name of [`switch-a-${suffix}`, `switch-b-${suffix}`]) {
    await page.getByRole("button", { name: "New source" }).click();
    await page
      .getByLabel("Repository URL")
      .fill(`https://github.com/e2e-owner/${name}`);
    await page.getByRole("button", { name: "Save source" }).click();
    await expect(page.getByLabel("Repository URL")).toHaveValue(
      `https://github.com/e2e-owner/${name}`,
    );
  }
  const nav = page.getByRole("navigation", { name: "Git sources" });
  await nav.getByRole("button", { name: new RegExp(`switch-a-${suffix}`) }).click();
  await expect(page.getByLabel("Repository URL")).toHaveValue(
    `https://github.com/e2e-owner/switch-a-${suffix}`,
  );
  const refInput = page.getByLabel("Branch, tag, or commit");
  hold = true;
  await nav.getByRole("button", { name: new RegExp(`switch-b-${suffix}`) }).click();
  await detailSeen;
  // Typed for source A while B loads; it must not become B's settings.
  await refInput.fill("draft-for-a");
  release();
  await expect(page.getByLabel("Repository URL")).toHaveValue(
    `https://github.com/e2e-owner/switch-b-${suffix}`,
  );
  await expect(refInput).toHaveValue("HEAD");
  await page.getByRole("button", { name: "Save source" }).click();
  await expect(page.getByRole("button", { name: "Save source" })).toBeEnabled();
  expect(patches.map((p) => p.ref)).not.toContain("draft-for-a");
});

test("@sources a scope edited while a create is in flight shows the created scope", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const suffix = Date.now().toString(36);
  const listPath = `/api/v1/workspaces/${encodeURIComponent(harness.workspaceId)}/sources`;
  let release: () => void = () => undefined,
    requested: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  const createSeen = new Promise<void>((resolve) => (requested = resolve));
  await page.route(`**${listPath}`, async (route) => {
    if (route.request().method() === "POST") {
      requested();
      await held;
    }
    await route.continue();
  });
  const created = `https://github.com/e2e-owner/created-${suffix}`;
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/sources`);
  const urlInput = page.getByLabel("Repository URL");
  await urlInput.fill(created);
  await page.getByRole("button", { name: "Save source" }).click();
  await createSeen;
  await urlInput.fill(`https://github.com/e2e-owner/edited-${suffix}`);
  release();
  await expect(page.getByRole("heading", { name: "Source settings" })).toBeVisible();
  // The read-only scope must be the persisted one, so later saves succeed.
  await expect(urlInput).toHaveValue(created);
  await page.getByLabel("Branch, tag, or commit").fill("release-c");
  const patched = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" && response.url().includes(listPath),
  );
  await page.getByRole("button", { name: "Save source" }).click();
  expect((await patched).status()).toBe(200);
  await expect(page.getByText("· track · release-c")).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
});

for (const width of [1024, 1100] as const)
  test(`@sources the catalog filters fit without horizontal overflow at ${width}px with the sidebar shown`, async ({
    context,
    page,
  }) => {
    await authenticate(context);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
    const filters = page.getByRole("region", { name: "Skill filters" });
    await expect(filters.getByLabel("Git source")).toBeVisible();
    await expect(filters.getByLabel("Lifecycle state")).toBeVisible();
    await expect(
      page.getByRole("complementary", { name: "Application navigation" }),
    ).toBeInViewport({ ratio: 0.95 });
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth);
  });
