import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  fakeGitHubAppBindings,
  startFakeGitHubInstallations,
  type FakeGitHubInstallations,
} from "../src/fake-github-installations.js";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

// Connect, list and unbind a GitHub App installation from workspace settings
// against a fake GitHub whose install page redirects back to the callback.
let harness: WorkspaceBrowserHarness;
let github: FakeGitHubInstallations;
const installationId = 7_000_000 + Math.floor(Math.random() * 1_000_000);

test.beforeAll(async () => {
  github = await startFakeGitHubInstallations();
  harness = await startWorkspaceBrowserHarness({
    bindings: fakeGitHubAppBindings(github),
  });
  github.callbackUrl = `${harness.origin}/github/setup`;
  github.addInstallation({
    id: installationId,
    account: { login: "e2e-org", type: "Organization" },
    repositorySelection: "selected",
    repositories: [
      { fullName: "e2e-org/private-skills", private: true, defaultBranch: "main" },
    ],
    users: ["e2e-user"],
  });
  github.nextInstall = { installationId, user: "e2e-user" };
});

test.afterAll(async () => {
  await harness?.close();
  await github?.close();
});

async function assertAccessible(page: Page, label: string) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      page: label,
      id: violation.id,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

test("@github connects, lists and unbinds a GitHub App installation", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
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
  await page.goto(`${harness.origin}/workspaces`);
  await page.getByLabel("Active workspace").selectOption(harness.workspaceId);
  await page.getByRole("link", { name: "GitHub" }).click();
  await expect(page.getByRole("heading", { name: "GitHub", level: 1 })).toBeVisible();
  await expect(page.getByText("No GitHub installations")).toBeVisible();
  await assertAccessible(page, "github settings empty");

  // The connect button leaves for GitHub, which returns to the callback.
  await page.getByRole("link", { name: "Connect GitHub" }).click();
  await expect(page).toHaveURL(`${harness.origin}/settings/github`);
  await expect(page.getByText("GitHub installation connected.")).toBeVisible();
  const row = page.getByRole("listitem").filter({ hasText: "e2e-org" }).first();
  await expect(row).toContainText("Active");
  await expect(
    page.getByRole("list", { name: "Repositories of e2e-org" }),
  ).toContainText("e2e-org/private-skills · private");
  await assertAccessible(page, "github settings connected");

  // A reload lists the binding from the server, not from the redirect.
  await page.reload();
  await expect(page.getByRole("button", { name: "Disconnect e2e-org" })).toBeVisible();

  await page.getByRole("button", { name: "Disconnect e2e-org" }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await assertAccessible(page, "github settings disconnect dialog");
  await page.getByRole("button", { name: "Disconnect installation" }).click();
  await expect(page.getByText("e2e-org was disconnected.")).toBeVisible();
  await expect(page.getByText("No GitHub installations")).toBeVisible();
});
