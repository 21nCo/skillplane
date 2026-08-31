import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import { createSkillBundleFixture } from "@skillplane/testing";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;
const screenshotDirectory = resolve(
  process.cwd(),
  ".conduct",
  "screenshots",
  "phase-07",
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

function skillPath(slug: string): string {
  return `${harness.origin}/${harness.workspaceSlug}/skills/${slug}`;
}

async function apiData<T>(response: { json(): Promise<unknown> }): Promise<T> {
  const envelope = (await response.json()) as { readonly data: T };
  return envelope.data;
}

function mutationHeaders(
  actor: "owner" | "viewer",
  idempotencyKey: string,
): Record<string, string> {
  return {
    "x-authfn-csrf": actor === "viewer" ? harness.invitedCsrfToken : harness.csrfToken,
    "x-skillplane-workspace-id": harness.workspaceId,
    "idempotency-key": idempotencyKey,
  };
}

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@skills exposes an actionable server-error and retry state", async ({
  context,
  page,
}) => {
  await authenticate(context);
  let fail = true;
  await page.route("**/datafn/query", async (route) => {
    const payload = route.request().postDataJSON() as { readonly resource?: string };
    if (!fail || payload.resource !== "skills") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        ok: false,
        error: {
          code: "TRANSPORT_ERROR",
          message: "Skill data is temporarily unavailable.",
          path: "/datafn/query",
        },
      }),
    });
  });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
  await expect(
    page.getByRole("heading", { name: "Skills could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "skills-error-retry-desktop-dark.png"),
    fullPage: true,
  });
  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("region", { name: "Skill inventory" })).toBeVisible();
});

test("@skills creates, versions, publishes, diffs, shares, archives, restores, and enforces viewer authorization", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await authenticate(context);
  const datafnSkillQueries: string[] = [];
  page.on("request", (request) => {
    if (!request.url().endsWith("/datafn/query")) return;
    const payload = request.postDataJSON() as { readonly resource?: string } | null;
    if (payload?.resource === "skills") datafnSkillQueries.push(request.url());
  });
  const skillName = "Browser PR review";
  const skillSlug = "browser-pr-review";
  const initialMarkdown =
    "# Browser PR review\n\n## Instructions\n\n1. Confirm authorization boundaries.\n2. Verify durable state after reload.\n3. Report evidence before style notes.\n";
  const updatedMarkdown =
    "# Browser PR review\n\n## Instructions\n\n1. Confirm authorization boundaries.\n2. Verify durable state after reload and direct navigation.\n3. Report persistence evidence before style notes.\n";

  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
  await expect.poll(() => datafnSkillQueries.length).toBeGreaterThan(0);
  await page.getByRole("link", { name: "New skill" }).click();
  await expect(
    page.getByRole("heading", { name: "Create durable agent guidance" }),
  ).toBeVisible();

  await page.getByRole("button", { name: "Publish version 1.0.0" }).click();
  expect(
    await page
      .getByLabel("Name")
      .evaluate((element) => !(element as HTMLInputElement).validity.valid),
  ).toBe(true);
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-create-validation-desktop-dark.png"),
    fullPage: true,
  });

  await page.getByLabel("Name").fill(skillName);
  await expect(page.getByLabel("Slug")).toHaveValue(skillSlug);
  await page
    .getByLabel("Description")
    .fill("Evidence-backed pull request review instructions");
  await page.getByLabel("Tags").fill("review, git, evidence");
  await page.getByLabel("SKILL.md").fill(initialMarkdown);
  await page.getByLabel("Initial visibility").selectOption("public");
  await page.getByRole("button", { name: "Publish version 1.0.0" }).click();

  await expect(page).toHaveURL(new RegExp(`/${skillSlug}\\?created=true$`, "u"));
  await expect(page.locator(".skill-heading h1")).toHaveText(skillName);
  await expect(
    page.getByText("Version 1.0.0 is published and ready for retrieval."),
  ).toBeVisible();
  await expect(page.getByText("Confirm authorization boundaries.")).toBeVisible();
  await page.reload();
  await expect(page.locator(".skill-heading h1")).toHaveText(skillName);
  await expect(page.locator(".facts dd").first()).toHaveText("v1.0.0");
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-overview-created-desktop-dark.png"),
    fullPage: true,
  });

  const skillNavigation = page.getByRole("navigation", { name: "Skill" });
  await skillNavigation.getByRole("link", { name: "Content" }).click();
  await expect(
    page.getByRole("heading", { name: "Browse exact version files" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Edit" }).click();
  await page.getByLabel("Skill instructions").fill(updatedMarkdown);
  await page
    .getByLabel("Change summary")
    .fill("Require persistence evidence after direct navigation");
  await page.getByLabel("Proposed semantic bump").selectOption("patch");
  await page.getByRole("button", { name: "Create candidate version" }).click();

  await expect(
    page.getByRole("heading", { name: "Candidate revision 2" }),
  ).toBeVisible();
  await expect(page.getByText("pending review", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Unified diff for SKILL.md")).toContainText(
    "persistence evidence",
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-candidate-exact-diff-desktop-dark.png"),
    fullPage: true,
  });
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Candidate revision 2" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish patch" }).click();
  await expect(page.getByRole("heading", { name: "Version 1.0.1" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Version 1.0.1" })).toBeVisible();

  await skillNavigation.getByRole("link", { name: "Versions" }).click();
  await expect(page.getByRole("heading", { name: "2 versions" })).toBeVisible();
  await page.getByRole("button", { name: "Compare versions" }).click();
  await expect(page.getByLabel("Unified diff for SKILL.md")).toContainText(
    "direct navigation",
  );
  await page.getByRole("button", { name: "Side by side" }).click();
  await expect(page.getByLabel("Before SKILL.md")).toBeVisible();
  await expect(page.getByLabel("After SKILL.md")).toBeVisible();

  const skillRecord = await apiData<{
    skill: { id: string; currentPublishedVersionId: string };
  }>(
    await page.request.get(
      `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/skills/by-slug/${skillSlug}`,
      {
        headers: {
          "x-skillplane-workspace-id": harness.workspaceId,
        },
      },
    ),
  );
  const baseVersionId = skillRecord.skill.currentPublishedVersionId;
  const conflictCandidates: string[] = [];
  for (const variant of ["winner", "loser"]) {
    const bytes = await createSkillBundleFixture({
      name: skillName,
      slug: skillSlug,
      description: "Evidence-backed pull request review instructions",
      tags: ["review", "git", "evidence"],
      skillMarkdown: `${updatedMarkdown}\nConflict ${variant}.\n`,
    });
    const candidateResponse = await page.request.post(
      `${harness.origin}/api/v1/skills/${skillRecord.skill.id}/versions`,
      {
        headers: mutationHeaders("owner", `browser-conflict-${variant}`),
        data: {
          bundleBase64: Buffer.from(bytes).toString("base64"),
          baseVersionId,
          proposedBump: "patch",
          changeSummary: `Conflict ${variant}`,
        },
      },
    );
    expect(candidateResponse.status()).toBe(201);
    const candidate = await apiData<{ version: { id: string } }>(candidateResponse);
    conflictCandidates.push(candidate.version.id);
  }
  const winnerResponse = await page.request.post(
    `${harness.origin}/api/v1/skills/${skillRecord.skill.id}/candidates/${conflictCandidates[0]}/approve`,
    {
      headers: mutationHeaders("owner", "browser-conflict-publish"),
    },
  );
  expect(winnerResponse.status()).toBe(200);
  await page.goto(`${skillPath(skillSlug)}/versions/${conflictCandidates[1]}`);
  await expect(
    page.getByRole("heading", { name: "Candidate revision 4" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Publish patch" }).click();
  await expect(
    page.getByRole("heading", { name: "Candidate state was not changed" }),
  ).toBeVisible();
  await expect(page.getByText(/conflict/u)).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-publish-conflict-desktop-dark.png"),
    fullPage: true,
  });

  await skillNavigation.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Skill visibility").selectOption("private");
  await page.getByRole("button", { name: "Save visibility" }).click();
  await expect(page.getByText("Visibility updated")).toBeVisible();
  await page.reload();
  await expect(page.getByText("private", { exact: true })).toBeVisible();
  const hiddenPublic = await page.request.get(
    `${harness.origin}/api/v1/skills/public/${harness.workspaceSlug}/${skillSlug}`,
  );
  expect(hiddenPublic.status()).toBe(404);

  await page.getByLabel("Skill visibility").selectOption("public");
  await page.getByRole("button", { name: "Save visibility" }).click();
  await expect(page.getByText("Visibility updated")).toBeVisible();
  const publicContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  const publicPage = await publicContext.newPage();
  await publicPage.goto(
    `${harness.origin}/skills/${harness.workspaceSlug}/${skillSlug}`,
  );
  await expect(publicPage.locator(".skill-header h1")).toHaveText(skillName);
  await expect(publicPage.getByText("Conflict winner.")).toBeVisible();
  await publicPage.screenshot({
    path: resolve(screenshotDirectory, "skill-public-share-desktop-dark.png"),
    fullPage: true,
  });
  await publicContext.close();

  await page.getByRole("button", { name: "Archive skill" }).click();
  const archiveDialog = page.getByRole("dialog", {
    name: "Archive this skill?",
  });
  await expect(archiveDialog).toBeVisible();
  await expect(archiveDialog).toContainText(/immutable version.*remain/u);
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-archive-confirmation-desktop-dark.png"),
    fullPage: true,
  });
  await archiveDialog.getByRole("button", { name: "Archive skill" }).click();
  await expect(page.getByText("Skill archived")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Archived", { exact: true }).first()).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-archived-settings-desktop-dark.png"),
    fullPage: true,
  });
  expect(
    (
      await page.request.get(
        `${harness.origin}/api/v1/skills/public/${harness.workspaceSlug}/${skillSlug}`,
      )
    ).status(),
  ).toBe(404);

  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
  await expect(page.getByText(skillName)).toHaveCount(0);
  await page.getByLabel("Lifecycle state").selectOption("archived");
  await expect(page.getByText(skillName)).toBeVisible();
  await page.getByRole("link", { name: new RegExp(skillName, "u") }).click();
  await skillNavigation.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("button", { name: "Restore skill" }).click();
  await expect(page.getByText("Skill restored")).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".skill-heading").getByText("Active", { exact: true }),
  ).toBeVisible();
  expect(
    (
      await page.request.get(
        `${harness.origin}/api/v1/skills/public/${harness.workspaceSlug}/${skillSlug}`,
      )
    ).status(),
  ).toBe(200);

  const viewerContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await authenticate(viewerContext, "viewer");
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);
  await expect(viewerPage.getByRole("link", { name: "New skill" })).toHaveCount(0);
  await viewerPage.getByRole("link", { name: new RegExp(skillName, "u") }).click();
  const viewerSkillNavigation = viewerPage.getByRole("navigation", {
    name: "Skill",
  });
  await viewerSkillNavigation.getByRole("link", { name: "Content" }).click();
  await expect(viewerPage.getByRole("button", { name: "Edit" })).toHaveCount(0);
  await viewerSkillNavigation.getByRole("link", { name: "Settings" }).click();
  await expect(
    viewerPage.getByRole("heading", { name: "Viewer access" }),
  ).toBeVisible();
  await expect(viewerPage.getByLabel("Skill visibility")).toBeDisabled();
  await expect(viewerPage.getByRole("button", { name: "Archive skill" })).toHaveCount(
    0,
  );
  await viewerPage.screenshot({
    path: resolve(screenshotDirectory, "skill-viewer-authorization-desktop-dark.png"),
    fullPage: true,
  });

  const forbidden = await viewerPage.request.patch(
    `${harness.origin}/api/v1/skills/${skillRecord.skill.id}`,
    {
      headers: mutationHeaders("viewer", "browser-viewer-forbidden"),
      data: { visibility: "private" },
    },
  );
  expect(forbidden.status()).toBe(403);
  expect(await forbidden.text()).toContain("FORBIDDEN");
  expect(
    (
      await viewerPage.request.get(
        `${harness.origin}/api/v1/skills/public/${harness.workspaceSlug}/${skillSlug}`,
      )
    ).status(),
  ).toBe(200);
  await viewerContext.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(skillPath(skillSlug));
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.screenshot({
    path: resolve(screenshotDirectory, "skill-overview-mobile-light.png"),
    fullPage: true,
  });
});
