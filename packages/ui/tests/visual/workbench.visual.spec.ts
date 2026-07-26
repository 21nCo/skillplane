import { expect, test } from "@playwright/test";

const viewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1440, height: 900 },
] as const;

for (const theme of ["dark", "light"] as const) {
  for (const viewport of viewports) {
    test(`${theme} ${viewport.width}px component inventory`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      await page.goto(`/?theme=${theme}&density=compact`);
      await expect(page).toHaveScreenshot(`workbench-${theme}-${viewport.width}.png`, {
        fullPage: true,
      });
    });
  }
}

test("comfortable density and destructive confirmation", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await page.goto("/?theme=light&density=comfortable");
  await page.getByRole("button", { name: "Archive", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Archive this skill?" })).toBeVisible();
  await expect(page).toHaveScreenshot("dialog-destructive-light-768.png", {
    fullPage: true,
  });
});
