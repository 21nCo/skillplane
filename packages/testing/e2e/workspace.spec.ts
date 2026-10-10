import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;
const screenshotDirectory = resolve(
  process.cwd(),
  ".conduct",
  "screenshots",
  "phase-04",
);

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test.beforeEach(async ({ context }) => {
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
});

test("@workspace creates, switches, persists, invites, and issues a one-time credential", async ({
  browser,
  page,
}) => {
  const suffix = Date.now().toString(36);
  const workspaceName = `Product systems ${suffix}`;
  const workspaceSlug = `product-systems-${suffix}`;

  await page.goto(`${harness.origin}/workspaces`);
  await expect(page.getByRole("heading", { name: "Workspaces" })).toBeVisible();
  await page.getByRole("button", { name: "New workspace" }).click();
  await page.getByLabel("Name").first().fill(workspaceName);
  await page.getByLabel("Workspace URL").first().fill(workspaceSlug);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText(`${workspaceName} was created.`)).toBeVisible();
  await expect(page.getByLabel("Active workspace")).toHaveValue(/workspace:/u);
  await expect(page.getByLabel("Name").last()).toHaveValue(workspaceName);

  await page.reload();
  await expect(page.getByLabel("Name").last()).toHaveValue(workspaceName);
  await expect(page.getByLabel("Workspace URL").last()).toHaveValue(workspaceSlug);
  await page.screenshot({
    path: resolve(screenshotDirectory, "workspaces-desktop-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: resolve(screenshotDirectory, "workspaces-desktop-light.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use dark theme" }).click();

  await page.getByRole("link", { name: "Members" }).click();
  await expect(page.getByRole("heading", { name: "Workspace members" })).toBeVisible();
  await page.getByRole("button", { name: "Invite member" }).click();
  await page.getByLabel("Email address").fill(harness.invitedEmail);
  await page.getByRole("button", { name: "Send invitation" }).click();
  await expect(page.getByText(/Invitation sent to/)).toBeVisible();
  const invitationMessage = JSON.stringify(harness.messages.at(-1));
  expect(invitationMessage).toContain("/invitations/spi_");
  const invitationToken = invitationMessage.match(
    /invitations\/(spi_[A-Za-z0-9_-]+)/u,
  )?.[1];
  expect(invitationToken).toBeDefined();
  if (!invitationToken) throw new Error("Invitation email did not contain a token");
  await page.screenshot({
    path: resolve(screenshotDirectory, "members-pending-invitation-dark.png"),
    fullPage: true,
  });

  const invitedContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await invitedContext.addCookies([
    {
      name: "__Secure-skillplane.session",
      value: harness.invitedSessionToken,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "skillplane.csrf",
      value: "workspace-invited-e2e-csrf",
      domain: "localhost",
      path: "/",
      secure: true,
      sameSite: "Lax",
    },
  ]);
  const invitedPage = await invitedContext.newPage();
  await invitedPage.goto(`${harness.origin}/invitations/${invitationToken}`);
  await expect(
    invitedPage.getByRole("heading", { name: `Join ${workspaceName}` }),
  ).toBeVisible();
  await invitedPage.screenshot({
    path: resolve(screenshotDirectory, "invitation-ready-dark.png"),
    fullPage: true,
  });
  await invitedPage.getByRole("button", { name: "Accept invitation" }).click();
  await expect(
    invitedPage.getByRole("heading", { name: `Welcome to ${workspaceName}` }),
  ).toBeVisible();
  await invitedPage.reload();
  await expect(
    invitedPage.getByRole("heading", { name: "This link can’t be used" }),
  ).toBeVisible();
  await invitedContext.close();

  await page.getByRole("link", { name: "Agent credentials" }).click();
  await page.getByRole("button", { name: "New credential" }).click();
  await page.getByLabel("Name").fill(`Review agent ${suffix}`);
  await page.getByRole("button", { name: "Create credential" }).click();
  const secret = page.locator(".secret code");
  await expect(secret).toContainText("spk_");
  const credential = await secret.textContent();
  expect(credential).toMatch(/^spk_/u);
  const browserStorage = await page.evaluate(() => ({
    local: JSON.stringify(localStorage),
    session: JSON.stringify(sessionStorage),
  }));
  expect(browserStorage.local).not.toContain(credential);
  expect(browserStorage.session).not.toContain(credential);
  await page.getByRole("button", { name: "I have saved it" }).click();
  await page.reload();
  await expect(page.getByText(`Review agent ${suffix}`)).toBeVisible();
  await expect(page.getByText("Version 1", { exact: false })).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "agent-credentials-desktop-dark.png"),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "Open navigation" }).click();
  await expect(
    page.getByRole("link", { name: "Skillplane workspaces" }),
  ).toBeInViewport({ ratio: 0.9 });
  await page.screenshot({
    path: resolve(screenshotDirectory, "workspace-mobile-navigation-dark.png"),
    fullPage: true,
  });
});
