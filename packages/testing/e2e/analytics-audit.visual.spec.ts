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

async function visit(
  page: Page,
  path: string,
  options: {
    readonly theme: "dark" | "light";
    readonly viewport: { readonly width: number; readonly height: number };
  },
): Promise<void> {
  await page.setViewportSize(options.viewport);
  await page.emulateMedia({
    colorScheme: options.theme,
    reducedMotion: "reduce",
  });
  await page.goto(`${harness.origin}/workspaces`);
  await page.evaluate(
    (theme) => localStorage.setItem("skillplane.theme", theme),
    options.theme,
  );
  await page.goto(`${harness.origin}${path}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", options.theme);
  await page.addStyleTag({
    content: `
      select[aria-label="Active workspace"],
      .workspace-meta strong,
      .content > header .title strong,
      .skill-heading h1,
      .skill-heading p,
      .skill-heading .meta,
      .chart-panel > header > span,
      .chart .bar-column span,
      .dimension:nth-child(3) li span,
      .audit-page input[type="date"],
      .audit-page time,
      .audit-page td:nth-child(2) small:not(.danger),
      .audit-page td code {
        color: transparent !important;
        text-shadow: none !important;
      }
      .content > header .title strong {
        width: 13rem !important;
      }
      .skill-heading h1 {
        display: inline-block !important;
        width: 16rem !important;
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

async function screenshot(page: Page, name: string): Promise<void> {
  await expect(page).toHaveScreenshot(name, {
    fullPage: true,
    animations: "disabled",
    maxDiffPixels: 0,
    threshold: 0.2,
  });
}

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
  await harness.seedObservability();
});

test.afterAll(async () => {
  await harness.close();
});

test("@analytics-audit matches responsive analytics and audit goldens", async ({
  context,
  page,
}) => {
  test.setTimeout(120_000);
  await authenticate(context);

  await visit(page, `/${harness.workspaceSlug}/analytics`, {
    theme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  await expect(
    page.getByRole("heading", { name: "Workspace analytics" }),
  ).toBeVisible();
  await expect(page.getByText("11", { exact: true }).first()).toBeVisible();
  await screenshot(page, "workspace-analytics-desktop-dark.png");

  await visit(page, `/${harness.workspaceSlug}/analytics`, {
    theme: "light",
    viewport: { width: 390, height: 844 },
  });
  await expect(page.getByText("Successful retrievals")).toBeVisible();
  await expect(page.getByText("11", { exact: true }).first()).toBeVisible();
  await screenshot(page, "workspace-analytics-mobile-light.png");

  await visit(page, `/${harness.workspaceSlug}/audit`, {
    theme: "light",
    viewport: { width: 1440, height: 900 },
  });
  await expect(page.getByRole("heading", { name: "Workspace audit" })).toBeVisible();
  await expect(page.getByText("13 audit events")).toBeVisible();
  await screenshot(page, "workspace-audit-desktop-light.png");

  await visit(page, `/${harness.workspaceSlug}/skills/${harness.skillSlug}/audit`, {
    theme: "dark",
    viewport: { width: 768, height: 1024 },
  });
  await expect(page.getByRole("heading", { name: "Skill audit" })).toBeVisible();
  await expect(page.getByText("13 audit events")).toBeVisible();
  await screenshot(page, "skill-audit-tablet-dark.png");
});
