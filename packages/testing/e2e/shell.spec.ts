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
  "phase-06",
);

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

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

async function expectNoAxeViolations(page: Page) {
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

test("@shell rejects anonymous access before protected content renders", async ({
  page,
}) => {
  await page.goto(`${harness.origin}/workspaces?source=guard`);
  await expect(page).toHaveURL(
    new RegExp(
      `/sign-in\\?next=${encodeURIComponent("/workspaces?source=guard")}$`,
      "u",
    ),
  );
  await expect(page.getByRole("heading", { name: "Workspaces" })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Continue to Skillplane" }),
  ).toBeVisible();
});

test("@shell routes the app entry to sign-in or the authenticated application", async ({
  context,
  page,
}) => {
  await page.goto(`${harness.origin}/`);
  await expect(page).toHaveURL(
    new RegExp(`/sign-in\\?next=${encodeURIComponent("/workspaces")}$`, "u"),
  );
  await expect(
    page.getByRole("heading", { name: "Continue to Skillplane" }),
  ).toBeVisible();

  await authenticate(context);
  await page.goto(`${harness.origin}/`);
  await expect(page).toHaveURL(`${harness.origin}/workspaces`);
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Application navigation" }),
  ).toBeVisible();

  await page.goto(`${harness.origin}/sign-in`);
  await expect(page).toHaveURL(`${harness.origin}/workspaces`);

  await page.goto(`${harness.origin}/verify`);
  await expect(page).toHaveURL(`${harness.origin}/workspaces`);
});

test("@shell provides accessible responsive navigation, themes, commands, and sign-out", async ({
  context,
  page,
}) => {
  await authenticate(context);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${harness.origin}/workspaces`);
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await expect(
    page.getByRole("complementary", { name: "Application navigation" }),
  ).toBeVisible();
  await expectNoAxeViolations(page);
  await page.screenshot({
    path: resolve(screenshotDirectory, "app-shell-1440-dark.png"),
    fullPage: true,
  });

  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: resolve(screenshotDirectory, "app-shell-1440-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use dark theme" }).click();

  await page.keyboard.press("Control+k");
  await expect(page.getByRole("dialog", { name: "Command menu" })).toBeVisible();
  await page.getByLabel("Search commands").fill("members");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Workspace members" })).toBeVisible();

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "app-shell-768-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();
  await page.getByRole("button", { name: "Open navigation" }).click();
  const sidebar = page.getByRole("complementary", { name: "Application navigation" });
  await expect(sidebar).toBeInViewport({ ratio: 0.95 });
  await expectNoAxeViolations(page);
  await page.screenshot({
    path: resolve(screenshotDirectory, "app-shell-390-drawer-dark.png"),
    fullPage: true,
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeVisible();

  await page.getByRole("button", { name: "Account", exact: true }).click();
  await page.getByRole("menuitem", { name: /Sign out/u }).click();
  await expect(page).toHaveURL(/\/sign-in$/u);
  const session = await page.request.get(`${harness.origin}/auth/session`);
  expect((await session.json()).data.session).toBeNull();
});
