import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
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
  "phase-09",
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

function mutationHeaders(
  idempotencyKey?: string,
  actor: "owner" | "viewer" = "owner",
): Record<string, string> {
  return {
    "x-authfn-csrf": actor === "viewer" ? harness.invitedCsrfToken : harness.csrfToken,
    "x-skillplane-workspace-id": harness.workspaceId,
    ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
  };
}

async function apiData<T>(response: { json(): Promise<unknown> }): Promise<T> {
  return ((await response.json()) as { readonly data: T }).data;
}

async function seedReview(page: Page) {
  const marker = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const skillSlug = `agent-review-${marker}`;
  const initialMarkdown =
    "# Agent review\n\nInspect the current source and tests before reporting findings.\n";
  const bundle = await createSkillBundleFixture({
    name: "Agent review",
    slug: skillSlug,
    description: "PR review guidance improved through agent learning",
    tags: ["review", "agent"],
    skillMarkdown: initialMarkdown,
  });
  const createdResponse = await page.request.post(
    `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/skills`,
    {
      headers: mutationHeaders(`e2e-skill-${marker}`),
      data: {
        bundleBase64: Buffer.from(bundle).toString("base64"),
        visibility: "workspace",
      },
    },
  );
  expect(createdResponse.status()).toBe(201);
  const created = await apiData<{
    skill: { id: string; slug: string };
    version: {
      id: string;
      manifest: { files: readonly { path: string; sha256: string }[] };
    };
  }>(createdResponse);
  const expectedSha256 = created.version.manifest.files.find(
    (file) => file.path === "SKILL.md",
  )?.sha256;
  if (!expectedSha256) throw new Error("SKILL.md digest was not returned");

  const contextResponse = await page.request.post(
    `${harness.origin}/api/v1/skills/${created.skill.id}/contexts`,
    {
      headers: mutationHeaders(`e2e-context-${marker}`),
      data: {
        slug: "repository",
        name: "Repository",
        type: "repository",
        externalReference: "github:skillplane/e2e",
        description: "Repository-specific review knowledge",
        metadata: { test: "amendment-review" },
        knowledge:
          "# Repository knowledge\n\nRead live review threads before concluding.\n",
        learningMetadata: { summary: "Captured live-thread requirement" },
      },
    },
  );
  expect(contextResponse.status()).toBe(201);
  const context = await apiData<{ context: { id: string } }>(contextResponse);

  const serviceResponse = await page.request.post(
    `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/service-principals`,
    {
      headers: mutationHeaders(),
      data: {
        name: `Trusted reviewer ${marker}`,
        role: "editor",
        scopes: ["skills:read", "skills:amend"],
      },
    },
  );
  expect(serviceResponse.status()).toBe(201);
  const service = await apiData<{
    servicePrincipal: { id: string; name: string };
  }>(serviceResponse);

  const amendmentResponse = await page.request.post(
    `${harness.origin}/api/v1/skills/${created.skill.id}/amendments`,
    {
      headers: mutationHeaders(`e2e-amendment-${marker}`),
      data: {
        baseVersionId: created.version.id,
        proposedBump: "patch",
        changes: [
          {
            operation: "replace",
            path: "SKILL.md",
            expectedSha256,
            content:
              "# Agent review\n\nInspect current source, tests, and live unresolved review threads before reporting findings.\n",
          },
        ],
        learning: {
          summary: "Require live unresolved review-thread evidence",
          observation:
            "A cached thread list caused an actionable review comment to be missed.",
          rationale:
            "The amended instruction makes live thread verification a completion gate.",
          confidence: "high",
          evidence: [
            {
              kind: "browser",
              reference: "reviewThreads:live",
              description: "The live state contained a thread absent from cached data.",
            },
          ],
          validation: [
            {
              kind: "e2e",
              status: "passed",
              description:
                "Candidate bundle, provenance, and diff loaded in review UI.",
            },
          ],
          sourceContextId: context.context.id,
          tags: ["review", "evidence"],
          externalReferences: [
            {
              label: "Review thread source",
              url: "https://example.test/review-threads",
            },
          ],
          extra: { source: "playwright", observationCount: 1 },
        },
        caller: {
          agent: "codex-reviewer",
          model: "gpt-5",
          client: "skillplane-mcp",
          runId: `run:${marker}`,
          sessionId: `session:${marker}`,
          conversationId: `conversation:${marker}`,
        },
      },
    },
  );
  expect(amendmentResponse.status()).toBe(201);
  const amendment = await apiData<{
    review: { id: string };
    candidate: { id: string };
  }>(amendmentResponse);
  return {
    skillId: created.skill.id,
    skillSlug,
    reviewId: amendment.review.id,
    candidateId: amendment.candidate.id,
    contextId: context.context.id,
    serviceName: service.servicePrincipal.name,
  };
}

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@amendments @amendment-review reviews, persists, role-gates, and configures trusted policy", async ({
  browser,
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await authenticate(context);
  const seeded = await seedReview(page);
  const candidatesPath = `${harness.origin}/${harness.workspaceSlug}/skills/${seeded.skillSlug}/candidates`;

  await page.goto(candidatesPath);
  await expect(
    page.getByRole("heading", { name: "Candidate revisions" }),
  ).toBeVisible();
  const row = page.locator(".review-list > a").filter({
    hasText: "Require live unresolved review-thread evidence",
  });
  await expect(row).toContainText("pending");
  await expect(row).toContainText("codex-reviewer / gpt-5");
  await page.screenshot({
    path: resolve(screenshotDirectory, "amendment-candidates-pending-desktop.png"),
    fullPage: true,
  });

  await row.click();
  await expect(
    page.getByRole("heading", {
      name: "Require live unresolved review-thread evidence",
      level: 2,
    }),
  ).toBeVisible();
  await expect(page.getByText("Authenticated requester")).toBeVisible();
  await expect(page.getByText("Declared agent caller")).toBeVisible();
  await expect(page.getByText("Context-backed learning")).toBeVisible();
  await expect(page.getByText("A cached thread list caused")).toBeVisible();
  await expect(page.getByText("replace", { exact: true })).toBeVisible();
  await expect(
    page.locator(".operations").getByText("SKILL.md", { exact: true }),
  ).toBeVisible();
  await expect(page.getByTestId("review-decision")).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "amendment-review-detail-desktop.png"),
    fullPage: true,
  });

  const viewerContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await authenticate(viewerContext, "viewer");
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(page.url());
  await expect(
    viewerPage.getByText("Admin or owner required", { exact: true }),
  ).toBeVisible();
  await expect(
    viewerPage.getByRole("button", { name: "Approve and publish" }),
  ).toHaveCount(0);
  await viewerPage.screenshot({
    path: resolve(screenshotDirectory, "amendment-review-viewer-readonly.png"),
    fullPage: true,
  });
  await viewerContext.close();

  await page
    .getByLabel("Decision rationale")
    .fill(
      "The exact diff, context provenance, evidence, and end-to-end validation are complete.",
    );
  await page.getByRole("button", { name: "Approve and publish" }).click();
  await expect(page.getByText("approved", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Approved review" })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("heading", { name: "Approved review" })).toBeVisible();
  await expect(page.getByText("end-to-end validation are complete")).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "amendment-review-approved-reload.png"),
    fullPage: true,
  });

  await page.goto(
    `${harness.origin}/${harness.workspaceSlug}/skills/${seeded.skillSlug}/settings`,
  );
  await expect(page.getByTestId("policy-editor")).toBeVisible();
  await page.getByRole("button", { name: /Trusted auto-publish/u }).click();
  await expect(
    page.getByRole("heading", { name: "Trust policy matrix" }),
  ).toBeVisible();
  await page.getByLabel("Trusted credential").selectOption({
    label: seeded.serviceName,
  });
  await page.getByLabel("Repository").check();
  await page.getByRole("button", { name: "Save amendment policy" }).click();
  await expect(page.getByText("Amendment policy saved.")).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("button", { name: /Trusted auto-publish.*Active/u }),
  ).toBeVisible();
  await expect(page.getByLabel("Trusted credential")).toHaveValue(
    /service-principal:/u,
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "amendment-policy-matrix-desktop.png"),
    fullPage: true,
  });
});
