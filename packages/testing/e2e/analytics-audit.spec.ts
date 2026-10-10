import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;
const screenshotDirectory = resolve(
  process.cwd(),
  ".conduct",
  "screenshots",
  "phase-13",
);

async function authenticate(
  context: BrowserContext,
  actor: "owner" | "viewer" = "owner",
): Promise<void> {
  const viewer = actor === "viewer";
  await context.addCookies([
    {
      name: "__Secure-skillplane.session",
      value: viewer ? harness.invitedSessionToken : harness.sessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "skillplane.csrf",
      value: viewer ? harness.invitedCsrfToken : harness.csrfToken,
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
}

async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startWorkspaceBrowserHarness();
  await harness.seedObservability();
});

test.afterAll(async () => {
  await harness.close();
});

test("@analytics renders database-backed workspace and skill metrics with role-safe navigation", async ({
  browser,
  context,
  page,
}) => {
  await authenticate(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/analytics`);
  await expect(
    page.getByRole("heading", { name: "Workspace analytics" }),
  ).toBeVisible();
  await expect(page.getByText("Successful retrievals")).toBeVisible();
  await expect(page.getByText("11", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Caller-declared agents").first()).toBeVisible();
  await expect(page.getByText("Codex Desktop")).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: resolve(screenshotDirectory, "workspace-analytics-desktop-dark.png"),
    fullPage: true,
  });

  await page.reload();
  await expect(page.getByText("11", { exact: true }).first()).toBeVisible();
  await page.goto(
    `${harness.origin}/${harness.workspaceSlug}/skills/${harness.skillSlug}`,
  );
  await page
    .getByRole("navigation", { name: "Skill" })
    .getByRole("link", {
      name: "Analytics",
    })
    .click();
  await expect(page.getByRole("heading", { name: "Skill analytics" })).toBeVisible();
  await expect(page.getByText("Current-version adoption")).toBeVisible();

  const viewerContext = await browser.newContext();
  await authenticate(viewerContext, "viewer");
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(`${harness.origin}/${harness.workspaceSlug}/analytics`);
  await expect(
    viewerPage.getByRole("heading", { name: "Workspace analytics" }),
  ).toBeVisible();
  await expect(
    viewerPage
      .getByRole("complementary", { name: "Application navigation" })
      .getByRole("link", { name: "Audit" }),
  ).toHaveCount(0);
  await expect(
    viewerPage.getByRole("navigation", { name: "Workspace" }).getByRole("link", {
      name: "Analytics",
    }),
  ).toBeVisible();
  await viewerContext.close();
});

test("@analytics exposes an actionable error and retry state", async ({
  context,
  page,
}) => {
  await authenticate(context);
  let fail = true;
  await page.route("**/api/v1/analytics/workspaces/**", async (route) => {
    if (!fail) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "ANALYTICS_UNAVAILABLE",
          message: "Analytics rollups are temporarily unavailable.",
          requestId: "request:analytics-retry",
        },
      }),
    });
  });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/analytics`);
  await expect(
    page.getByRole("heading", { name: "Analytics could not be loaded" }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "workspace-analytics-error-retry.png"),
    fullPage: true,
  });
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByText("Successful retrievals")).toBeVisible();
});

test("@audit filters and exports redacted history while denying viewer detail", async ({
  browser,
  context,
  page,
}) => {
  await authenticate(context);
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/audit`);
  await expect(page.getByRole("heading", { name: "Workspace audit" })).toBeVisible();
  await expect(page.getByText("Authenticated", { exact: true }).first()).toBeVisible();
  await expect(
    page.getByText("Caller-declared", { exact: true }).first(),
  ).toBeVisible();
  await expect(page.getByText("Codex Desktop").first()).toBeVisible();
  await expect(page.getByText("request:browser-observability:amendment")).toBeVisible();
  await expectAccessible(page);
  await page.screenshot({
    path: resolve(screenshotDirectory, "workspace-audit-desktop-dark.png"),
    fullPage: true,
  });

  await page.getByLabel("Outcome").selectOption("denied");
  await page.getByLabel("Caller-declared agent").fill("Codex Desktop");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("1 audit events")).toBeVisible();
  await expect(page.getByText("AUTH_SCOPE_REQUIRED")).toBeVisible();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export current filters" }).click();
  const exported = await download;
  expect(exported.suggestedFilename()).toMatch(
    /^skillplane-audit-\d{4}-\d{2}-\d{2}\.csv$/u,
  );

  await page.getByRole("button", { name: "Reset" }).click();
  await page.goto(
    `${harness.origin}/${harness.workspaceSlug}/skills/${harness.skillSlug}`,
  );
  await page
    .getByRole("navigation", { name: "Skill" })
    .getByRole("link", {
      name: "Audit",
    })
    .click();
  await expect(page.getByRole("heading", { name: "Skill audit" })).toBeVisible();

  const viewerContext = await browser.newContext();
  await authenticate(viewerContext, "viewer");
  const viewerResponse = await viewerContext.request.get(
    `${harness.origin}/api/v1/audit/workspaces/${harness.workspaceId}`,
    { headers: { "x-skillplane-workspace-id": harness.workspaceId } },
  );
  expect(viewerResponse.status()).toBe(403);
  expect(await viewerResponse.text()).not.toContain("request:browser-observability");
  await viewerContext.close();
});
