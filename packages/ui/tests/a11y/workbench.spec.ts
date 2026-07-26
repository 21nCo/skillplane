import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

async function assertAccessible(page: Page) {
  const result = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"])
    .analyze();
  expect(
    result.violations.map((violation) => ({
      id: violation.id,
      impact: violation.impact,
      nodes: violation.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
}

for (const theme of ["dark", "light"] as const) {
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 768, height: 1024 },
    { width: 1440, height: 900 },
  ]) {
    test(`${theme} workbench is accessible at ${viewport.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(viewport);
      await page.goto(`/?theme=${theme}&density=compact`);
      await expect(
        page.getByRole("heading", { name: /Compact controls/u }),
      ).toBeVisible();
      await assertAccessible(page);
      const overflow = await page.evaluate(
        () =>
          document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(1);
    });
  }
}

test("keyboard interaction, dialog focus, menu, tabs, and command routing work", async ({
  page,
}) => {
  await page.goto("/?theme=dark&density=compact");

  const create = page.getByRole("button", { name: "New skill" });
  await create.focus();
  await page.keyboard.press("Enter");
  const dialog = page.getByRole("dialog", { name: "Create a skill" });
  await expect(dialog).toBeVisible();
  await expect(page.getByLabel("Name")).toBeFocused();
  await assertAccessible(page);
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  await expect(create).toBeFocused();

  await page.getByRole("button", { name: "Actions", exact: true }).click();
  await expect(page.getByRole("menu", { name: "Actions" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Publish version/u })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /Archive skill/u })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("button", { name: "Actions", exact: true }),
  ).toBeFocused();

  const overview = page.getByRole("tab", { name: "Overview" });
  await overview.focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("tab", { name: /Versions/u })).toHaveAttribute(
    "aria-selected",
    "true",
  );

  await page.keyboard.press("Control+k");
  const commands = page.getByRole("dialog", { name: "Command menu" });
  await expect(commands).toBeVisible();
  await page.getByLabel("Search commands").fill("workspace");
  await expect(
    page.getByRole("option", { name: /Open workspace settings/u }),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(commands).toBeHidden();
});

test("reduced motion contract disables meaningful animation", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?theme=dark&density=comfortable");
  const duration = await page
    .getByRole("status", { name: "Loading" })
    .first()
    .evaluate((element) => getComputedStyle(element).animationDuration);
  expect(Number.parseFloat(duration)).toBeLessThanOrEqual(0.01);
});
