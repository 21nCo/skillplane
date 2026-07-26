import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import {
  startLandingBrowserHarness,
  type LandingBrowserHarness,
} from "./support/landing-browser-harness.js";

let harness: LandingBrowserHarness;
const evidenceDirectory = resolve(process.cwd(), ".conduct", "screenshots", "phase-14");

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
  await page.goto(harness.origin);
  await page.evaluate(
    (theme) => localStorage.setItem("skillplane.theme", theme),
    options.theme,
  );
  await page.goto(`${harness.origin}${path}`);
  await expect(page.locator("html")).toHaveAttribute("data-theme", options.theme);
  await page.addStyleTag({
    content: `
      .workspace,
      .breadcrumbs span:not([aria-hidden="true"]),
      .metadata span:last-child,
      .version-heading time,
      .metadata-card dl div:nth-child(2) dd,
      .metadata-card dl div:nth-child(4) code,
      .version-row code {
        color: transparent !important;
        text-shadow: none !important;
      }
      *,
      *::before,
      *::after {
        caret-color: transparent !important;
      }
    `,
  });
  await page.evaluate(() => {
    const dynamicTerm = /landingfixture[a-f0-9]+/gu;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      current.textContent =
        current.textContent?.replace(dynamicTerm, "landingfixturestable") ?? null;
      current = walker.nextNode();
    }
    const search = document.querySelector<HTMLInputElement>("#skill-search");
    if (search)
      search.value = search.value.replace(dynamicTerm, "landingfixturestable");
  });
  await page.evaluate(() => document.fonts.ready);
}

async function screenshot(
  page: Page,
  goldenName: string,
  evidenceName: string,
): Promise<void> {
  await expect(page).toHaveScreenshot(goldenName, {
    fullPage: true,
    animations: "disabled",
    maxDiffPixels: 0,
    threshold: 0.2,
  });
  await page.screenshot({
    path: resolve(evidenceDirectory, evidenceName),
    fullPage: true,
    animations: "disabled",
  });
}

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  harness = await startLandingBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@landing-visual matches responsive production goldens", async ({ page }) => {
  test.setTimeout(180_000);

  await visit(page, "/", {
    theme: "dark",
    viewport: { width: 1440, height: 900 },
  });
  await screenshot(
    page,
    "landing-home-desktop-dark.png",
    "landing-home-desktop-dark.png",
  );

  await visit(page, "/", {
    theme: "light",
    viewport: { width: 390, height: 844 },
  });
  await screenshot(
    page,
    "landing-home-mobile-light.png",
    "landing-home-mobile-light.png",
  );

  await visit(page, `/skills?q=${harness.publicSearchTerm}`, {
    theme: "light",
    viewport: { width: 1440, height: 900 },
  });
  await expect(
    page.locator(
      `a[href="/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}"]`,
    ),
  ).toBeVisible();
  await screenshot(
    page,
    "landing-directory-desktop-light.png",
    "landing-directory-desktop-light.png",
  );

  await visit(page, `/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}`, {
    theme: "dark",
    viewport: { width: 768, height: 1024 },
  });
  await expect(
    page.getByRole("heading", { name: "Published version history" }),
  ).toBeVisible();
  await screenshot(
    page,
    "landing-skill-tablet-dark.png",
    "landing-skill-tablet-dark.png",
  );

  await visit(page, "/skills", {
    theme: "dark",
    viewport: { width: 390, height: 844 },
  });
  await expect(page.getByRole("search")).toHaveAttribute("data-hydrated", "true");
  await page.getByLabel("Search published skills").fill(`noresult${"x".repeat(20)}`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "No published skills match that search." }),
  ).toBeVisible();
  await screenshot(
    page,
    "landing-directory-empty-mobile-dark.png",
    "landing-directory-empty-mobile-dark.png",
  );
});
