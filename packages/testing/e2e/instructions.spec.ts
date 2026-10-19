import { expect, test, type BrowserContext } from "@playwright/test";
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

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@instructions creates, edits, reviews and publishes instructions in the UI", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const workspacePath = `${harness.origin}/${harness.workspaceSlug}`;
  const skillMarkdownRequests: string[] = [];
  const datafnSkillFilters: unknown[] = [];
  const serverErrors: string[] = [];
  page.on("response", (response) => {
    if (response.status() >= 500) serverErrors.push(response.url());
  });
  page.on("request", (request) => {
    if (/\/files\/SKILL\.md$/u.test(new URL(request.url()).pathname)) {
      skillMarkdownRequests.push(request.url());
    }
    if (request.url().endsWith("/datafn/query")) {
      const body = request.postDataJSON() as {
        readonly resource?: string;
        readonly filters?: unknown;
      };
      if (body.resource === "skills") datafnSkillFilters.push(body.filters);
    }
  });

  const skillBundle = await createSkillBundleFixture({
    name: "Release checklist",
    slug: "release-checklist",
    skillMarkdown: "# Release checklist\n\nVerify every gate.\n",
  });
  const skillResponse = await page.request.post(
    `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/skills`,
    {
      headers: {
        "x-authfn-csrf": harness.csrfToken,
        "x-skillplane-workspace-id": harness.workspaceId,
        "idempotency-key": "instructions-e2e-skill",
      },
      data: {
        bundleBase64: Buffer.from(skillBundle).toString("base64"),
        visibility: "workspace",
      },
    },
  );
  expect(skillResponse.status()).toBe(201);

  // Create entirely in the UI.
  await page.goto(`${workspacePath}/instructions`);
  await expect(
    page.getByRole("heading", { name: "Instructions", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "New instructions" }).click();
  await page.getByLabel("Name").fill("Repository conventions");
  await expect(page.getByLabel("Slug")).toHaveValue("repository-conventions");
  await expect(page.getByTestId("markdown-editor")).toHaveAttribute(
    "data-surface",
    "instructions-create",
  );
  await page
    .getByLabel("AGENTS.md", { exact: true })
    .fill("# Conventions\n\nRun the formatter before committing.\n");
  await page.getByLabel("Visibility").selectOption("workspace");
  await page.getByRole("button", { name: "Publish version 1.0.0" }).click();

  await expect(page).toHaveURL(
    /\/instructions\/repository-conventions\?created=true$/u,
  );
  await expect(page.locator("header h1")).toHaveText("Repository conventions");
  await expect(page.locator('[data-artifact-kind="instructions"]')).toHaveText(
    "Instructions",
  );
  await expect(page.getByText("Run the formatter before committing.")).toBeVisible();

  // The instructions list shows only instructions, each with its kind.
  await page.goto(`${workspacePath}/instructions`);
  const instructionsInventory = page.getByRole("region", {
    name: "Instructions inventory",
  });
  await expect(instructionsInventory.getByRole("article")).toHaveCount(1);
  await expect(instructionsInventory).toContainText("Repository conventions");
  await expect(instructionsInventory).toContainText("Instructions");
  await expect(instructionsInventory).not.toContainText("Release checklist");

  // Skill lists, skill search and the DataFn listing never show instructions.
  await page.goto(`${workspacePath}/skills`);
  const skillInventory = page.getByRole("region", { name: "Skill inventory" });
  await expect(skillInventory).toContainText("Release checklist");
  const skillRows = await skillInventory.getByRole("article").count();
  await expect(skillInventory.locator('[data-artifact-kind="skill"]')).toHaveCount(
    skillRows,
  );
  await expect(
    skillInventory.locator('[data-artifact-kind="instructions"]'),
  ).toHaveCount(0);
  await expect(skillInventory).not.toContainText("Repository conventions");
  expect(datafnSkillFilters).toContainEqual(expect.objectContaining({ kind: "skill" }));
  await page.getByLabel("Search skills").fill("formatter");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("No skills match these filters")).toBeVisible();

  // Opening instructions through a skill route lands on the instructions route.
  await page.goto(`${workspacePath}/skills/repository-conventions`);
  await expect(page).toHaveURL(/\/instructions\/repository-conventions$/u);
  await expect(page.getByText("Run the formatter before committing.")).toBeVisible();

  // Edit, submit a version, review the diff and publish.
  const navigation = page.getByRole("navigation", { name: "Instructions" });
  await navigation.getByRole("link", { name: "Edit" }).click();
  await expect(page.getByTestId("markdown-editor")).toHaveAttribute(
    "data-surface",
    "instructions-revise",
  );
  await expect(page.getByLabel("AGENTS.md", { exact: true })).toHaveValue(
    "# Conventions\n\nRun the formatter before committing.\n",
  );
  await page
    .getByLabel("AGENTS.md", { exact: true })
    .fill("# Conventions\n\nRun the formatter and linter before committing.\n");
  await page.getByLabel("Change summary").fill("Require the linter");
  await page.getByLabel("Proposed semantic bump").selectOption("minor");
  await page.getByRole("button", { name: "Submit version for review" }).click();

  await expect(
    page.getByRole("heading", { name: "Candidate revision 2" }),
  ).toBeVisible();
  await expect(page.getByText("pending review", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Unified diff for AGENTS.md")).toContainText(
    "formatter and linter",
  );
  await page.getByRole("button", { name: "Publish minor" }).click();
  await expect(page.getByRole("heading", { name: "Version 1.1.0" })).toBeVisible();

  await navigation.getByRole("link", { name: "Versions" }).click();
  await expect(page.getByRole("heading", { name: "2 versions" })).toBeVisible();
  await page.getByRole("button", { name: "Compare versions" }).click();
  await expect(page.getByLabel("Unified diff for AGENTS.md")).toContainText(
    "formatter and linter",
  );
  await navigation.getByRole("link", { name: "Document" }).click();
  await expect(
    page.getByText("Run the formatter and linter before committing."),
  ).toBeVisible();

  expect(skillMarkdownRequests).toEqual([]);
  expect(serverErrors).toEqual([]);
});
