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

async function stabilize(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      select[aria-label="Active workspace"],
      .workspace-meta strong,
      .content > header .title strong,
      time,
      .public-shell .eyebrow > span:first-child {
        color: transparent !important;
        text-shadow: none !important;
      }
      .content > header .title strong {
        width: 13rem !important;
      }
      .public-shell .eyebrow > span:first-child {
        display: inline-block !important;
        width: 18rem !important;
      }
      *,
      *::before,
      *::after {
        caret-color: transparent !important;
      }
    `,
  });
  await page.evaluate(() => document.fonts.ready);
}

async function visit(
  page: Page,
  path: string,
  options: {
    readonly theme: "dark" | "light";
    readonly viewport: { readonly width: number; readonly height: number };
    readonly publicPage?: boolean;
  },
): Promise<void> {
  await page.setViewportSize(options.viewport);
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: "reduce",
  });
  await page.evaluate(
    (theme) => localStorage.setItem("skillplane.theme", theme),
    options.theme,
  );
  await page.goto(`${harness.origin}${path}`);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (options.publicPage) {
    await page.locator("html").evaluate((element, theme) => {
      (element as HTMLElement).dataset.theme = theme;
      (element as HTMLElement).dataset.density = "compact";
    }, options.theme);
  } else {
    await expect(page.locator("html")).toHaveAttribute("data-theme", options.theme);
  }
  await stabilize(page);
}

async function screenshot(
  page: Page,
  name: string,
  options: { fullPage?: boolean } = {},
): Promise<void> {
  await expect(page).toHaveScreenshot(name, {
    fullPage: options.fullPage ?? true,
    animations: "disabled",
    maxDiffPixels: 0,
    threshold: 0.2,
  });
}

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@skill-pages-visual matches the production skill-page goldens", async ({
  context,
  page,
}) => {
  test.setTimeout(150_000);
  await authenticate(context);
  await page.goto(`${harness.origin}/${harness.workspaceSlug}/skills`);

  const slug = "visual-review";
  const initialBundle = await createSkillBundleFixture({
    name: "Visual review",
    slug,
    description: "Consistent, evidence-backed interface review",
    tags: ["review", "evidence"],
    skillMarkdown:
      "# Visual review\n\n## Instructions\n\n1. Inspect the complete workflow.\n2. Record durable evidence.\n3. Report exact outcomes.\n",
    files: {
      "references/checklist.md":
        "# Checklist\n\n- Responsive layout\n- Keyboard flow\n- Persistence\n",
    },
  });
  const createdResponse = await page.request.post(
    `${harness.origin}/api/v1/workspaces/${harness.workspaceId}/skills`,
    {
      headers: mutationHeaders("visual-create"),
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
    name: "Visual review",
    slug,
    description: "Consistent, evidence-backed interface review",
    tags: ["review", "evidence"],
    skillMarkdown:
      "# Visual review\n\n## Instructions\n\n1. Inspect the complete workflow.\n2. Record durable and responsive evidence.\n3. Report exact outcomes.\n",
    files: {
      "references/checklist.md":
        "# Checklist\n\n- Responsive layout\n- Keyboard flow\n- Persistence\n",
    },
  });
  const candidateResponse = await page.request.post(
    `${harness.origin}/api/v1/skills/${created.skill.id}/versions`,
    {
      headers: mutationHeaders("visual-candidate"),
      data: {
        bundleBase64: Buffer.from(candidateBundle).toString("base64"),
        baseVersionId: created.version.id,
        proposedBump: "patch",
        changeSummary: "Clarify responsive evidence",
      },
    },
  );
  expect(candidateResponse.status()).toBe(201);
  const candidate = await data<{ version: { id: string } }>(candidateResponse);

  await visit(page, `/${harness.workspaceSlug}/skills`, {
    theme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  await page.getByLabel("Search skills").fill("Visual review");
  await page.getByRole("button", { name: "Search" }).click();
  await expect(page.getByText("Visual review", { exact: true })).toBeVisible();
  await stabilize(page);
  await screenshot(page, "skills-list-desktop-dark.png");

  await visit(page, `/${harness.workspaceSlug}/skills/new`, {
    theme: "light",
    viewport: { width: 1440, height: 900 },
  });
  await expect(
    page.getByRole("heading", { name: "Create durable agent guidance" }),
  ).toBeVisible();
  await screenshot(page, "skill-create-desktop-light.png");

  await visit(page, `/${harness.workspaceSlug}/skills/${slug}`, {
    theme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  await expect(page.locator(".skill-heading h1")).toHaveText("Visual review");
  await screenshot(page, "skill-overview-desktop-dark.png");

  await visit(page, `/${harness.workspaceSlug}/skills/${slug}/content`, {
    theme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  await expect(
    page.getByRole("heading", { name: "Browse exact version files" }),
  ).toBeVisible();
  await expect(page.getByText("Inspect the complete workflow.")).toBeVisible();
  await screenshot(page, "skill-content-desktop-dark.png");

  await visit(page, `/${harness.workspaceSlug}/skills/${slug}/versions`, {
    theme: "dark",
    viewport: { width: 768, height: 1024 },
  });
  await expect(page.getByRole("heading", { name: "2 versions" })).toBeVisible();
  await page.getByRole("button", { name: "Compare versions" }).click();
  await expect(page.getByLabel("Unified diff for SKILL.md")).toBeVisible();
  await stabilize(page);
  await screenshot(page, "skill-versions-tablet-dark.png");

  await visit(
    page,
    `/${harness.workspaceSlug}/skills/${slug}/versions/${candidate.version.id}`,
    {
      theme: "light",
      viewport: { width: 1440, height: 900 },
    },
  );
  await expect(
    page.getByRole("heading", { name: "Candidate revision 2" }),
  ).toBeVisible();
  await page.getByText(/^user:user:workspace-browser-/).evaluate((element) => {
    element.textContent = "user:user:workspace-browser-visual";
  });
  await screenshot(page, "skill-version-detail-desktop-light.png");

  await visit(page, `/${harness.workspaceSlug}/skills/${slug}/settings`, {
    theme: "light",
    viewport: { width: 1440, height: 900 },
  });
  await page
    .getByRole("button", { name: "Archive skill" })
    .evaluate((element) => (element as HTMLButtonElement).click());
  await expect(page.getByRole("dialog", { name: "Archive this skill?" })).toBeVisible();
  await stabilize(page);
  await screenshot(page, "skill-settings-dialog-desktop-light.png", {
    fullPage: false,
  });
  await page.keyboard.press("Escape");

  await visit(page, `/skills/${harness.workspaceSlug}/${slug}`, {
    theme: "light",
    viewport: { width: 1440, height: 900 },
    publicPage: true,
  });
  await expect(page.locator(".skill-header h1")).toHaveText("Visual review");
  await screenshot(page, "skill-public-desktop-light.png");

  await visit(page, `/${harness.workspaceSlug}/skills/${slug}`, {
    theme: "light",
    viewport: { width: 390, height: 844 },
  });
  await expect(page.locator(".skill-heading h1")).toHaveText("Visual review");
  await screenshot(page, "skill-overview-mobile-light.png");
});
