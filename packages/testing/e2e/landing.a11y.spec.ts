import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import {
  startLandingBrowserHarness,
  type LandingBrowserHarness,
} from "./support/landing-browser-harness.js";

let harness: LandingBrowserHarness;

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
  expect(overflow, `${label} horizontal overflow`).toBeLessThanOrEqual(1);
}

test.beforeAll(async () => {
  harness = await startLandingBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@landing-a11y passes WCAG checks at required viewports in both themes", async ({
  page,
}) => {
  test.setTimeout(180_000);
  const viewports = [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ] as const;
  const paths = [
    { name: "home", path: "/" },
    { name: "directory", path: "/skills" },
    {
      name: "detail",
      path: `/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}`,
    },
  ] as const;

  await page.goto(harness.origin);
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
      for (const route of paths) {
        await page.goto(`${harness.origin}${route.path}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await assertAccessible(page, `${route.name}-${theme}-${viewport.width}`);
      }
    }
  }
});

test("@landing-a11y provides visible focus, a skip link, and keyboard mobile navigation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness.origin);
  await page.keyboard.press("Tab");
  const skip = page.getByRole("link", { name: "Skip to main content" });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/#main-content$/u);

  const menu = page.getByRole("button", { name: "Open navigation menu" });
  await expect(menu).toHaveAttribute("data-hydrated", "true");
  await menu.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByRole("navigation", { name: "Mobile navigation" }),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page
      .getByRole("navigation", { name: "Mobile navigation" })
      .getByRole("link")
      .first(),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(menu).toBeFocused();
});
