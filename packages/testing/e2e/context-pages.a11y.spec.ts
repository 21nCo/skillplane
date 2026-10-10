import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
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

function mutationHeaders(key: string): Record<string, string> {
  return {
    "x-authfn-csrf": harness.csrfToken,
    "x-skillplane-workspace-id": harness.workspaceId,
    "idempotency-key": key,
  };
}

async function data<T>(response: { json(): Promise<unknown> }): Promise<T> {
  const envelope = (await response.json()) as { readonly data: T };
  return envelope.data;
}

async function assertAccessible(page: Page, label: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      page: label,
      id: violation.id,
      impact: violation.impact,
      targets: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  if (overflow > 1) {
    const offenders = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("body *")]
        .map((element) => {
          const rect = element.getBoundingClientRect();
          return {
            tag: element.tagName.toLocaleLowerCase(),
            className: element.className,
            left: Math.round(rect.left),
            right: Math.round(rect.right),
            width: Math.round(rect.width),
            text: element.textContent?.trim().slice(0, 60) ?? "",
          };
        })
        .filter((entry) => entry.right > document.documentElement.clientWidth + 1)
        .slice(0, 12),
    );
    throw new Error(
      `${label} horizontal overflow ${String(overflow)}: ${JSON.stringify(offenders)}`,
    );
  }
  expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);
}

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@context-pages-a11y passes context routes, themes, viewports, and keyboard dialogs", async ({
  context: browserContext,
  page,
}) => {
  test.setTimeout(180_000);
  await authenticate(browserContext);
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);

  const slug = "accessible-repository";
  const createResponse = await page.request.post(
    `${harness.origin}/api/v1/skills/${harness.skillId}/contexts`,
    {
      headers: mutationHeaders("a11y-context-create"),
      data: {
        slug,
        name: "Accessible repository",
        type: "repository",
        externalReference: "github:example/accessible",
        description: "Scoped and keyboard-accessible repository learning",
        metadata: { runtime: "node-22", accessibility: true },
        knowledge:
          "# Accessible repository\n\nUse exact source, named controls, and durable evidence.\n",
        learningMetadata: {
          summary: "Captured accessible operating guidance",
          confidence: "high",
        },
      },
    },
  );
  expect(createResponse.status()).toBe(201);
  const created = await data<{
    context: { id: string };
    knowledge: { revision: number };
  }>(createResponse);

  const updateResponse = await page.request.put(
    `${harness.origin}/api/v1/contexts/${created.context.id}/knowledge`,
    {
      headers: mutationHeaders("a11y-knowledge-update"),
      data: {
        expectedRevision: created.knowledge.revision,
        knowledge:
          "# Accessible repository\n\nUse exact source, named controls, keyboard flows, and durable evidence.\n",
        learningMetadata: {
          summary: "Added explicit keyboard-flow guidance",
          confidence: "high",
        },
      },
    },
  );
  expect(updateResponse.status()).toBe(200);

  const noteResponse = await page.request.post(
    `${harness.origin}/api/v1/contexts/${created.context.id}/notes`,
    {
      headers: mutationHeaders("a11y-note-create"),
      data: {
        title: "Keyboard review",
        body: "Confirm focus restoration after every modal workflow.",
        learningMetadata: {
          summary: "Retain the focus-restoration convention",
          source: "accessibility review",
        },
      },
    },
  );
  expect(noteResponse.status()).toBe(201);
  const note = await data<{ note: { id: string } }>(noteResponse);

  const base = `/${harness.workspaceSlug}/skills/${harness.skillSlug}/contexts`;
  const routes = [
    {
      path: base,
      ready: () => page.getByRole("heading", { name: "Contexts" }),
      name: "context-list",
    },
    {
      path: `${base}/${slug}`,
      ready: () => page.getByRole("heading", { name: "Context knowledge" }),
      name: "context-detail",
    },
    {
      path: `${base}/${slug}/history`,
      ready: () => page.getByRole("heading", { name: "Revision history" }),
      name: "context-history",
    },
    {
      path: `${base}/${slug}/history?note=${encodeURIComponent(note.note.id)}`,
      ready: () => page.getByRole("heading", { name: "Keyboard review revision 1" }),
      name: "context-note-history",
    },
  ] as const;
  const viewports = [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ] as const;

  for (const theme of ["dark", "light"] as const) {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
      await page.evaluate(
        (nextTheme) => localStorage.setItem("skillplane.theme", nextTheme),
        theme,
      );
      for (const route of routes) {
        await page.goto(`${harness.origin}${route.path}`);
        await expect(route.ready()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await assertAccessible(
          page,
          `${route.name}-${theme}-${String(viewport.width)}`,
        );
      }
    }
  }

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`${harness.origin}${base}`);
  const createButton = page.getByRole("button", { name: "New context" });
  await createButton.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("heading", { name: "Create scoped knowledge" }),
  ).toBeVisible();
  await assertAccessible(page, "context-create-form-keyboard");
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(createButton).toBeFocused();

  await page.goto(`${harness.origin}${base}/${slug}`);
  const amendButton = page.getByRole("button", { name: "Amend knowledge" });
  await amendButton.focus();
  await page.keyboard.press("Enter");
  const knowledgeDialog = page.getByRole("dialog", {
    name: "Amend context knowledge",
  });
  await expect(knowledgeDialog).toBeVisible();
  await assertAccessible(page, "knowledge-dialog-keyboard");
  await page.keyboard.press("Escape");
  await expect(knowledgeDialog).toBeHidden();
  await expect(amendButton).toBeFocused();

  const noteCard = page
    .locator(".note-grid article")
    .filter({ hasText: "Keyboard review" });
  const archiveNoteButton = noteCard.getByRole("button", { name: "Archive" });
  await archiveNoteButton.focus();
  await page.keyboard.press("Enter");
  const archiveNoteDialog = page.getByRole("dialog", {
    name: "Archive shared note?",
  });
  await expect(archiveNoteDialog).toBeVisible();
  await assertAccessible(page, "archive-note-dialog-keyboard");
  await page.keyboard.press("Escape");
  await expect(archiveNoteDialog).toBeHidden();
  await expect(archiveNoteButton).toBeFocused();

  const archiveContextButton = page
    .locator(".context-heading")
    .getByRole("button", { name: "Archive", exact: true });
  await archiveContextButton.focus();
  await page.keyboard.press("Enter");
  const archiveContextDialog = page.getByRole("dialog", {
    name: "Archive context?",
  });
  await expect(archiveContextDialog).toBeVisible();
  await assertAccessible(page, "archive-context-dialog-keyboard");
  await page.keyboard.press("Escape");
  await expect(archiveContextDialog).toBeHidden();
  await expect(archiveContextButton).toBeFocused();
});
