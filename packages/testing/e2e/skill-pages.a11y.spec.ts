import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
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
      `${label} horizontal overflow ${overflow}: ${JSON.stringify(offenders)}`,
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

test("@skill-pages-a11y passes the required viewport and theme matrix", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await authenticate(context);
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);

  const slug = "accessible-review";
  const initialBundle = await createSkillBundleFixture({
    name: "Accessible review",
    slug,
    description: "Keyboard-accessible review instructions",
    tags: ["accessibility", "review"],
    skillMarkdown:
      "# Accessible review\n\nUse evidence, keyboard-reachable actions, and explicit outcomes.\n",
    files: {
      "references/checklist.md": "# Checklist\n\n- Labels\n- Focus\n- Contrast\n",
    },
  });
  const createdResponse = await page.request.post(
    `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/skills`,
    {
      headers: mutationHeaders("a11y-create"),
      data: {
        bundleBase64: Buffer.from(initialBundle).toString("base64"),
        visibility: "public",
      },
    },
  );
  expect(createdResponse.status()).toBe(201);
  const created = await data<{
    skill: { id: string };
    version: { id: string };
  }>(createdResponse);

  const candidateBundle = await createSkillBundleFixture({
    name: "Accessible review",
    slug,
    description: "Keyboard-accessible review instructions",
    tags: ["accessibility", "review"],
    skillMarkdown:
      "# Accessible review\n\nUse evidence, keyboard-reachable actions, explicit outcomes, and reload verification.\n",
    files: {
      "references/checklist.md": "# Checklist\n\n- Labels\n- Focus\n- Contrast\n",
    },
  });
  const candidateResponse = await page.request.post(
    `${harness.origin}/api/v1/skills/${created.skill.id}/versions`,
    {
      headers: mutationHeaders("a11y-candidate"),
      data: {
        bundleBase64: Buffer.from(candidateBundle).toString("base64"),
        baseVersionId: created.version.id,
        proposedBump: "patch",
        changeSummary: "Add reload verification",
      },
    },
  );
  expect(candidateResponse.status()).toBe(201);
  const candidate = await data<{ version: { id: string } }>(candidateResponse);

  const protectedRoutes = [
    {
      path: `/${harness.workspaceSlug}/skills`,
      ready: () => page.getByRole("heading", { name: "Skills" }),
      name: "list",
    },
    {
      path: `/${harness.workspaceSlug}/skills/new`,
      ready: () => page.getByRole("heading", { name: "Create durable agent guidance" }),
      name: "create",
    },
    {
      path: `/${harness.workspaceSlug}/skills/${slug}`,
      ready: () => page.locator(".skill-heading h1"),
      name: "overview",
    },
    {
      path: `/${harness.workspaceSlug}/skills/${slug}/content`,
      ready: () => page.getByRole("heading", { name: "Browse exact version files" }),
      name: "content",
    },
    {
      path: `/${harness.workspaceSlug}/skills/${slug}/versions`,
      ready: () => page.getByRole("heading", { name: "Version diff" }),
      name: "versions",
    },
    {
      path: `/${harness.workspaceSlug}/skills/${slug}/versions/${candidate.version.id}`,
      ready: () => page.getByRole("heading", { name: "Candidate revision 2" }),
      name: "version-detail",
    },
    {
      path: `/${harness.workspaceSlug}/skills/${slug}/settings`,
      ready: () => page.getByRole("heading", { name: "Visibility" }),
      name: "settings",
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
      await page.emulateMedia({
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await page.evaluate(
        (nextTheme) => localStorage.setItem("skillplane.theme", nextTheme),
        theme,
      );
      for (const route of protectedRoutes) {
        await page.goto(`${harness.origin}${route.path}`);
        await expect(route.ready()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await assertAccessible(page, `${route.name}-${theme}-${viewport.width}`);
      }

      await page.goto(`${harness.origin}/skills/${harness.workspaceSlug}/${slug}`);
      await expect(page.locator(".skill-header h1")).toHaveText("Accessible review");
      await page.locator("html").evaluate((element, nextTheme) => {
        (element as HTMLElement).dataset.theme = nextTheme;
      }, theme);
      await assertAccessible(page, `public-${theme}-${viewport.width}`);
    }
  }

  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills/${slug}/settings`);
  const archiveButton = page.getByRole("button", { name: "Archive skill" });
  await archiveButton.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Archive this skill?" });
  await expect(dialog).toBeVisible();
  await assertAccessible(page, "archive-dialog-keyboard");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(archiveButton).toBeFocused();

  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills/new`);
  const markdownTab = page.getByRole("tab", { name: "Author Markdown" });
  await markdownTab.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: "Upload bundle" })).toHaveAttribute(
    "aria-selected",
    "true",
  );
});
