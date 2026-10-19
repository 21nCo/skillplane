import { expect, test, type BrowserContext } from "@playwright/test";
import {
  createInstructionsBundleFixture,
  createSkillBundleFixture,
} from "@skillplane/testing";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;

async function authenticate(context: BrowserContext, viewer = false): Promise<void> {
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

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@instructions creates, edits, reviews and publishes instructions in the UI", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const workspacePath = `${harness.origin}/${harness.workspaceSlug}`;
  const skillMarkdownRequests: string[] = [];
  const datafnSkillFilters: unknown[] = [];
  const serverErrors: string[] = [];
  // Every page of every scenario context is observed, not only the first page.
  const observeServerErrors = (observed: BrowserContext) =>
    observed.on("response", (response) => {
      if (response.status() >= 500) serverErrors.push(response.url());
    });
  observeServerErrors(context);
  context.on("request", (request) => {
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
  const candidateUrl = page.url();

  // A second editor starts from v1.0.0 while the candidate is pending.
  const stalePage = await context.newPage();
  await stalePage.goto(`${workspacePath}/instructions/repository-conventions/edit`);
  await expect(stalePage.getByLabel("AGENTS.md", { exact: true })).toHaveValue(
    "# Conventions\n\nRun the formatter before committing.\n",
  );

  // A viewer can read instructions but cannot create, edit or publish them.
  const viewerContext = await browser.newContext();
  observeServerErrors(viewerContext);
  try {
    await authenticate(viewerContext, true);
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(`${workspacePath}/instructions`);
    await expect(
      viewerPage
        .getByRole("region", { name: "Instructions inventory" })
        .getByRole("article"),
    ).toHaveCount(1);
    await expect(
      viewerPage.getByRole("link", { name: "New instructions" }),
    ).toHaveCount(0);
    await viewerPage.goto(candidateUrl);
    await expect(
      viewerPage.getByRole("heading", { name: "Candidate revision 2" }),
    ).toBeVisible();
    await expect(
      viewerPage.getByText("Admin or owner approval required"),
    ).toBeVisible();
    await expect(viewerPage.getByRole("button", { name: "Publish minor" })).toHaveCount(
      0,
    );
    await viewerPage.goto(`${workspacePath}/instructions/repository-conventions/edit`);
    await expect(viewerPage.getByText("Editor access required")).toBeVisible();
    await expect(viewerPage.getByLabel("AGENTS.md", { exact: true })).toHaveCount(0);
  } finally {
    await viewerContext.close();
  }

  await page.getByRole("button", { name: "Publish minor" }).click();
  await expect(page.getByRole("heading", { name: "Version 1.1.0" })).toBeVisible();

  // Submitting against the superseded v1.0.0 base is refused and creates nothing.
  await stalePage
    .getByLabel("AGENTS.md", { exact: true })
    .fill("# Conventions\n\nA stale edit.\n");
  await stalePage.getByLabel("Change summary").fill("Stale edit");
  await stalePage.getByRole("button", { name: "Submit version for review" }).click();
  await expect(
    stalePage
      .getByRole("alert")
      .filter({ hasText: "The base version is no longer current" }),
  ).toBeVisible();
  await expect(stalePage).toHaveURL(/\/instructions\/repository-conventions\/edit$/u);
  await stalePage.close();

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

test("@instructions gives a document with the slug new its own route", async ({
  context,
  page,
}) => {
  await authenticate(context);
  const workspacePath = `${harness.origin}/${harness.workspaceSlug}`;

  await page.goto(`${workspacePath}/instructions`);
  await page.getByRole("link", { name: "New instructions" }).click();
  await page.getByLabel("Name").fill("New");
  await expect(page.getByLabel("Slug")).toHaveValue("new");
  await page
    .getByLabel("AGENTS.md", { exact: true })
    .fill("# New\n\nReachable at its own route.\n");
  await page.getByRole("button", { name: "Publish version 1.0.0" }).click();

  await expect(page).toHaveURL(/\/instructions\/new\?created=true$/u);
  await expect(page.locator("header h1")).toHaveText("New");
  await expect(page.getByText("Reachable at its own route.")).toBeVisible();

  // Reopening it from the inventory shows the document, not the creation form.
  await page.goto(`${workspacePath}/instructions`);
  await page
    .getByRole("region", { name: "Instructions inventory" })
    .getByRole("article")
    .filter({ has: page.locator("code", { hasText: /^new$/u }) })
    .getByRole("link")
    .click();
  await expect(page).toHaveURL(/\/instructions\/new$/u);
  await expect(page.getByText("Reachable at its own route.")).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Write an AGENTS.md document" }),
  ).toHaveCount(0);
});

test("@instructions keeps paging, submission and archived edits consistent", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);
  const workspacePath = `${harness.origin}/${harness.workspaceSlug}`;
  const headers = (key: string) => ({
    "x-authfn-csrf": harness.csrfToken,
    "x-skillplane-workspace-id": harness.workspaceId,
    "idempotency-key": key,
  });
  let archivedId = "";
  for (let index = 0; index < 21; index += 1) {
    const slug = `paged-${String(index).padStart(2, "0")}`;
    const response = await page.request.post(
      `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/skills`,
      {
        headers: headers(`instructions-e2e-${slug}`),
        data: {
          bundleBase64: Buffer.from(
            await createInstructionsBundleFixture({
              name: `Paged ${slug}`,
              slug,
              document: `# ${slug}\n`,
            }),
          ).toString("base64"),
          visibility: "workspace",
        },
      },
    );
    expect(response.status()).toBe(201);
    if (index === 0) {
      archivedId = ((await response.json()) as { data: { skill: { id: string } } }).data
        .skill.id;
    }
  }

  // Loading more keeps the loaded search even after the field was edited.
  await page.goto(`${workspacePath}/instructions`);
  const inventory = page.getByRole("region", { name: "Instructions inventory" });
  await expect(inventory.getByRole("article")).toHaveCount(20);
  await page.getByLabel("Search instructions").fill("unsubmitted");
  await page.getByRole("button", { name: "Load more instructions" }).click();
  await expect
    .poll(async () => inventory.getByRole("article").count())
    .toBeGreaterThan(20);
  await expect(page.getByText("Instructions could not be loaded")).toHaveCount(0);

  // The form is locked while a creation request is in flight, and the request
  // carries the values that were submitted.
  await page.goto(`${workspacePath}/instructions/-/new`);
  await page.getByLabel("Name").fill("Locked submission");
  await page.getByLabel("AGENTS.md", { exact: true }).fill("# Locked\n");
  let release!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  let submitted: { visibility?: string } | null = null;
  await page.route(
    (url) => /^\/api\/v1\/workspaces\/[^/]+\/skills$/u.test(url.pathname),
    async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      submitted = route.request().postDataJSON() as { visibility?: string };
      await held;
      return route.fallback();
    },
  );
  await page.getByRole("button", { name: "Publish version 1.0.0" }).click();
  await expect.poll(() => submitted).not.toBeNull();
  await expect(page.getByLabel("Name")).toBeDisabled();
  await expect(page.getByLabel("Visibility")).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Publish version 1.0.0" }),
  ).toBeDisabled();
  release();
  await expect(page).toHaveURL(/\/instructions\/locked-submission\?created=true$/u);
  expect(submitted).toMatchObject({ visibility: "private" });
  await page.unrouteAll();

  // An archived document cannot be edited, even by direct navigation.
  const archived = await page.request.post(
    `${harness.origin}/api/v1/skills/${archivedId}/archive`,
    { headers: headers("instructions-e2e-archive") },
  );
  expect(archived.status()).toBe(200);
  await page.goto(`${workspacePath}/instructions/paged-00/edit`);
  await expect(
    page.getByRole("heading", { name: "Archived instructions cannot be edited" }),
  ).toBeVisible();
  await expect(page.getByLabel("AGENTS.md", { exact: true })).toHaveCount(0);
});
