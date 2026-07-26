import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type BrowserContext } from "@playwright/test";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

let harness: WorkspaceBrowserHarness;
const screenshotDirectory = resolve(
  process.cwd(),
  ".conduct",
  "screenshots",
  "phase-08",
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
  actor: "owner" | "viewer",
  idempotencyKey: string,
): Record<string, string> {
  return {
    "x-authfn-csrf": actor === "viewer" ? harness.invitedCsrfToken : harness.csrfToken,
    "x-skillplane-workspace-id": harness.workspaceId,
    "idempotency-key": idempotencyKey,
  };
}

async function apiData<T>(response: { json(): Promise<unknown> }): Promise<T> {
  const envelope = (await response.json()) as { readonly data: T };
  return envelope.data;
}

function contextsPath(suffix = ""): string {
  return `${harness.origin}/${harness.workspaceSlug}/skills/${harness.skillSlug}/contexts${suffix}`;
}

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@contexts exposes an actionable context-inventory error and retry state", async ({
  context,
  page,
}) => {
  await authenticate(context);
  let fail = true;
  await page.route("**/api/v1/skills/*/contexts*", async (route) => {
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
          code: "DATABASE_UNAVAILABLE",
          message: "Context storage is temporarily unavailable.",
          requestId: "req_context_retry",
        },
      }),
    });
  });

  await page.goto(contextsPath());
  await expect(
    page.getByRole("heading", { name: "Contexts could not be loaded" }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Retry" })).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "contexts-error-retry-desktop-dark.png"),
    fullPage: true,
  });

  fail = false;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator(".inventory article").first()).toBeVisible();
});

test("@contexts creates, amends, detects stale revisions, persists notes, archives, restores, and enforces viewer access", async ({
  browser,
  context: browserContext,
  page,
}) => {
  test.setTimeout(180_000);
  await authenticate(browserContext);
  const contextName = "btnextjs repository";
  const contextSlug = "btnextjs";
  const initialKnowledge =
    "# btnextjs\n\nUse Node 22 and verify review findings against the current source.\n";
  const serverKnowledge =
    "# btnextjs\n\nUse Node 22. The repository requires evidence from current source and test output.\n";
  const finalKnowledge =
    "# btnextjs\n\nUse Node 22. Cite current source, test output, and unresolved review threads.\n";
  const noteTitle = "Review conventions";

  await page.goto(contextsPath());
  await page.getByRole("button", { name: "New context" }).click();
  await expect(
    page.getByRole("heading", { name: "Create scoped knowledge" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Create context" }).click();
  expect(
    await page
      .getByLabel("Name")
      .evaluate((element) => !(element as HTMLInputElement).validity.valid),
  ).toBe(true);
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-create-validation-desktop-dark.png"),
    fullPage: true,
  });

  await page.getByLabel("Name").fill(contextName);
  await expect(page.getByLabel("Slug")).toHaveValue("btnextjs-repository");
  await page.getByLabel("Slug").fill(contextSlug);
  await page.getByLabel("Context type").selectOption("repository");
  await page.getByLabel("External reference").fill("github:21dotco/btnextjs");
  await page
    .getByLabel("Description")
    .fill("Repository-specific pull request review knowledge");
  await page
    .getByLabel("Context metadata (JSON)")
    .fill('{"repository":"21dotco/btnextjs","runtime":"node-22"}');
  await page.getByLabel("Initial shared knowledge").fill(initialKnowledge);
  await page
    .getByLabel("Learning summary")
    .fill("Captured the repository runtime and evidence standard");
  await page
    .getByLabel("Additional learning metadata (JSON)")
    .fill('{"confidence":"high","source":"maintainer"}');
  await page.getByRole("button", { name: "Create context" }).click();

  await expect(page).toHaveURL(
    new RegExp(`/contexts/${contextSlug}\\?created=true$`, "u"),
  );
  await expect(
    page.getByText("Context and immutable knowledge revision 1 were created"),
  ).toBeVisible();
  await expect(
    page.getByText("Version 1.0.0 is published and ready for retrieval."),
  ).toHaveCount(0);
  await expect(page.locator(".knowledge .rendered")).toContainText(
    "Use Node 22 and verify review findings",
  );
  await page.reload();
  await expect(page.getByText("Knowledge revision 1", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("definition").filter({ hasText: "github:21dotco/btnextjs" }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-detail-created-desktop-dark.png"),
    fullPage: true,
  });

  const contextRecord = await apiData<{
    context: { id: string };
  }>(
    await page.request.get(
      `${harness.origin}/api/v1/skills/${harness.skillId}/contexts/by-slug/${contextSlug}`,
      {
        headers: { "x-skillplane-workspace-id": harness.workspaceId },
      },
    ),
  );

  await page.getByRole("button", { name: "Amend knowledge" }).click();
  const knowledgeDialog = page.getByRole("dialog", {
    name: "Amend context knowledge",
  });
  await expect(knowledgeDialog).toBeVisible();
  await knowledgeDialog.getByLabel("Shared knowledge Markdown").fill(finalKnowledge);
  await knowledgeDialog
    .getByLabel("Learning summary")
    .fill("Added unresolved review-thread checks");

  const externalUpdate = await page.request.put(
    `${harness.origin}/api/v1/contexts/${contextRecord.context.id}/knowledge`,
    {
      headers: mutationHeaders("owner", "browser-context-external-update"),
      data: {
        expectedRevision: 1,
        knowledge: serverKnowledge,
        learningMetadata: {
          summary: "Added current-source and test-output evidence",
          source: "maintainer",
        },
      },
    },
  );
  expect(externalUpdate.status()).toBe(200);
  await knowledgeDialog
    .getByRole("button", { name: "Save immutable revision" })
    .click();
  await expect(
    knowledgeDialog.getByText("Knowledge changed while you were editing"),
  ).toBeVisible();
  await expect(knowledgeDialog.getByText("Revision 2 is current")).toBeVisible();
  await knowledgeDialog.getByRole("alert").scrollIntoViewIfNeeded();
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-knowledge-conflict-desktop-dark.png"),
  });

  await knowledgeDialog.getByRole("button", { name: "Load current revision" }).click();
  await expect(knowledgeDialog).toBeHidden();
  await expect(page.getByText("Knowledge revision 2", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Amend knowledge" }).click();
  await knowledgeDialog.getByLabel("Shared knowledge Markdown").fill(finalKnowledge);
  await knowledgeDialog
    .getByLabel("Learning summary")
    .fill("Added unresolved review-thread checks");
  await knowledgeDialog
    .getByRole("button", { name: "Save immutable revision" })
    .click();
  await expect(page.getByText("Knowledge revision 3 created")).toBeVisible();
  await page.reload();
  await expect(page.getByText("Knowledge revision 3", { exact: true })).toBeVisible();
  await expect(page.locator(".knowledge .rendered")).toContainText(
    "unresolved review threads",
  );

  await page.getByRole("button", { name: "New note" }).click();
  const noteDialog = page.getByRole("dialog", { name: "Create shared note" });
  await noteDialog.getByLabel("Note title").fill(noteTitle);
  await noteDialog
    .getByLabel("Note Markdown")
    .fill("Check `reviewThreads` before calling a review complete.");
  await noteDialog
    .getByLabel("Learning summary")
    .fill("Preserve unresolved review-thread evidence");
  await noteDialog
    .getByLabel("Additional learning metadata (JSON)")
    .fill('{"source":"prior-review","confidence":"high"}');
  await noteDialog.getByRole("button", { name: "Create shared note" }).click();
  await expect(page.getByText("Note revision 1 saved")).toBeVisible();
  await page.reload();
  const noteCard = page.locator(".note-grid article").filter({ hasText: noteTitle });
  await expect(noteCard).toContainText("reviewThreads");
  await noteCard.getByRole("button", { name: "Edit" }).click();
  const amendNoteDialog = page.getByRole("dialog", { name: "Amend shared note" });
  await amendNoteDialog
    .getByLabel("Note Markdown")
    .fill(
      "Check `reviewThreads`, resolve actionable threads, and report remaining blockers.",
    );
  await amendNoteDialog
    .getByLabel("Learning summary")
    .fill("Added explicit actionable-thread and blocker handling");
  await amendNoteDialog
    .getByRole("button", { name: "Save immutable revision" })
    .click();
  await expect(page.getByText("Note revision 2 saved")).toBeVisible();
  await page.reload();
  await expect(noteCard).toContainText("remaining blockers");

  await noteCard.getByRole("link", { name: "History" }).click();
  await expect(page.getByRole("heading", { name: "Revision history" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `${noteTitle} revision 2` }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: `${noteTitle} revision 1` }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-note-history-desktop-dark.png"),
    fullPage: true,
  });

  await page.getByRole("link", { name: contextName }).click();
  const activeNote = page.locator(".note-grid article").filter({ hasText: noteTitle });
  await activeNote.getByRole("button", { name: "Archive" }).click();
  const archiveNoteDialog = page.getByRole("dialog", {
    name: "Archive shared note?",
  });
  await expect(archiveNoteDialog).toContainText(
    "immutable revisions remain in history",
  );
  await archiveNoteDialog.getByRole("button", { name: "Archive note" }).click();
  await expect(page.getByText("Note archived")).toBeVisible();
  await expect(activeNote).toHaveCount(0);
  await page.getByLabel("Note lifecycle").selectOption("archived");
  await expect(
    page.locator(".note-grid article").filter({ hasText: noteTitle }),
  ).toContainText("Archived");

  await page.getByRole("button", { name: "Archive", exact: true }).click();
  const archiveContextDialog = page.getByRole("dialog", {
    name: "Archive context?",
  });
  await expect(archiveContextDialog).toContainText(
    "knowledge and note revisions remain durable",
  );
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-archive-confirmation-desktop-dark.png"),
  });
  await archiveContextDialog.getByRole("button", { name: "Archive context" }).click();
  await expect(page.getByText("Context archived")).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".context-heading").getByText("Archived", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-archived-desktop-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Restore" }).click();
  await page
    .getByRole("dialog", { name: "Restore context?" })
    .getByRole("button", { name: "Restore context" })
    .click();
  await expect(page.getByText("Context restored")).toBeVisible();
  await page.reload();
  await expect(
    page.locator(".context-heading").getByText("Archived", { exact: true }),
  ).toHaveCount(0);

  const viewerContext = await browser.newContext({
    viewport: { width: 1280, height: 900 },
  });
  await authenticate(viewerContext, "viewer");
  const viewerPage = await viewerContext.newPage();
  await viewerPage.goto(contextsPath(`/${contextSlug}`));
  await expect(viewerPage.getByText("Read-only access")).toBeVisible();
  await expect(viewerPage.getByRole("button", { name: "Amend knowledge" })).toHaveCount(
    0,
  );
  await expect(viewerPage.getByRole("button", { name: "New note" })).toHaveCount(0);
  await expect(
    viewerPage.getByRole("button", { name: "Archive", exact: true }),
  ).toHaveCount(0);
  const forbidden = await viewerPage.request.put(
    `${harness.origin}/api/v1/contexts/${contextRecord.context.id}/knowledge`,
    {
      headers: mutationHeaders("viewer", "browser-context-viewer-forbidden"),
      data: {
        expectedRevision: 3,
        knowledge: "A viewer must not mutate this knowledge.",
        learningMetadata: { summary: "Forbidden" },
      },
    },
  );
  expect(forbidden.status()).toBe(403);
  expect(await forbidden.text()).toContain("FORBIDDEN");
  await viewerPage.screenshot({
    path: resolve(screenshotDirectory, "context-viewer-authorization-desktop-dark.png"),
    fullPage: true,
  });
  await viewerContext.close();

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => localStorage.setItem("skillplane.theme", "light"));
  await page.goto(contextsPath(`/${contextSlug}`));
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(page.getByRole("heading", { name: contextName })).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "context-detail-mobile-light.png"),
    fullPage: true,
  });
});
