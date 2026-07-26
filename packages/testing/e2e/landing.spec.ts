import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  startLandingBrowserHarness,
  type LandingBrowserHarness,
} from "./support/landing-browser-harness.js";

let harness: LandingBrowserHarness;
const evidenceDirectory = resolve(process.cwd(), ".conduct", "screenshots", "phase-14");

test.beforeAll(async () => {
  await mkdir(evidenceDirectory, { recursive: true });
  harness = await startLandingBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test("@landing presents an accurate product workflow and production navigation", async ({
  page,
}) => {
  await page.goto(harness.origin);
  await expect(
    page.getByRole("heading", {
      name: "Skills that improve without losing control.",
    }),
  ).toBeVisible();
  await expect(page.getByText("Create", { exact: true })).toBeVisible();
  await expect(page.getByText("Contextualize", { exact: true })).toBeVisible();
  await expect(page.getByText("Retrieve", { exact: true })).toBeVisible();
  await expect(page.getByText("Amend", { exact: true })).toBeVisible();
  await expect(page.getByText("Review", { exact: true })).toBeVisible();
  await expect(page.getByText("Publish", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Caller provenance" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Trust the process, then verify every step." }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Create your first skill" }),
  ).toHaveAttribute("href", "https://app.skillplane.dev/sign-in?intent=signup");
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toHaveAttribute(
    "href",
    "https://app.skillplane.dev/sign-in",
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", /dark|light/u);

  const themeButton = page.getByRole("button", { name: /Use (light|dark) theme/u });
  const initialTheme = await page.locator("html").getAttribute("data-theme");
  await expect(themeButton).toHaveAttribute("data-hydrated", "true");
  await expect(themeButton).toHaveAccessibleName(
    initialTheme === "light" ? "Use dark theme" : "Use light theme",
  );
  await themeButton.click();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-theme",
    initialTheme ?? "",
  );
  await page.reload();
  await expect(page.locator("html")).not.toHaveAttribute(
    "data-theme",
    initialTheme ?? "",
  );
});

test("@landing discovers, searches, and opens production-backed public skills", async ({
  page,
}) => {
  await page.goto(`${harness.origin}/skills`);
  await expect(
    page.getByRole("heading", { name: "Discover skills built to be reused." }),
  ).toBeVisible();
  await expect(page.getByRole("search")).toHaveAttribute("data-hydrated", "true");
  const reviewLink = page.locator(
    `a[href="/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}"]`,
  );
  await expect(page.getByText("Internal production runbook")).toHaveCount(0);

  await page.getByLabel("Search published skills").fill(harness.publicSearchTerm);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(reviewLink).toBeVisible();
  await expect(page.getByText("Incident triage", { exact: true })).toHaveCount(0);

  await reviewLink.click();
  await expect(page).toHaveURL(
    `${harness.origin}/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}`,
  );
  await expect(
    page
      .locator(".skill-header")
      .getByRole("heading", { name: "Pull request review", level: 1 }),
  ).toBeVisible();
  await expect(page.getByTestId("safe-markdown")).toContainText(
    "Regression evidence and rollback safety",
  );
  await expect(
    page.getByRole("heading", { name: "Published version history" }),
  ).toBeVisible();
  await expect(page.getByText("v1.0.1", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("v1.0.0", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "This page contains published skill content only. Context knowledge, notes, candidates, and audit records remain private.",
    ),
  ).toBeVisible();
});

test("@landing exposes loading, empty, validation, error, and retry states", async ({
  page,
}) => {
  await page.goto(`${harness.origin}/skills`);
  await expect(page.getByRole("search")).toHaveAttribute("data-hydrated", "true");
  const search = page.getByLabel("Search published skills");

  await search.fill(`noresult${crypto.randomUUID().replaceAll("-", "")}`);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "No published skills match that search.",
    }),
  ).toBeVisible();

  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __skillplaneOriginalFetch?: typeof fetch;
    };
    const originalFetch = window.fetch.bind(window);
    browserWindow.__skillplaneOriginalFetch = originalFetch;
    window.fetch = async (...arguments_) => {
      if (String(arguments_[0]).includes("/api/public-skills")) {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
      }
      return originalFetch(...arguments_);
    };
  });
  await search.fill(harness.publicSearchTerm);
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByText("Searching published skills")).toBeVisible();
  await expect(page.locator(".skeleton-card").first()).toBeVisible();
  await page.screenshot({
    path: resolve(evidenceDirectory, "landing-directory-loading-desktop-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await expect(
    page.locator(
      `a[href="/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}"]`,
    ),
  ).toBeVisible();
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __skillplaneOriginalFetch?: typeof fetch;
    };
    if (browserWindow.__skillplaneOriginalFetch) {
      window.fetch = browserWindow.__skillplaneOriginalFetch;
    }
  });

  await search.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.removeAttribute("maxlength");
    input.value = "x".repeat(501);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Search terms must be 500 characters or fewer.",
  );

  await search.fill(harness.publicSearchTerm);
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __skillplaneOriginalFetch?: typeof fetch;
    };
    const originalFetch = window.fetch.bind(window);
    browserWindow.__skillplaneOriginalFetch = originalFetch;
    window.fetch = async (input, init) => {
      if (String(input).includes("/api/public-skills")) {
        return new Response(
          JSON.stringify({
            ok: false,
            error: {
              code: "PUBLIC_API_UNAVAILABLE",
              message: "Public skill discovery is temporarily unavailable.",
              requestId: "req_browser_failure",
            },
          }),
          {
            status: 503,
            headers: { "content-type": "application/json" },
          },
        );
      }
      return originalFetch(input, init);
    };
  });
  await page.getByRole("button", { name: "Search", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Skills could not be loaded.");
  await page.screenshot({
    path: resolve(evidenceDirectory, "landing-directory-error-desktop-light.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.evaluate(() => {
    const browserWindow = window as typeof window & {
      __skillplaneOriginalFetch?: typeof fetch;
    };
    if (browserWindow.__skillplaneOriginalFetch) {
      window.fetch = browserWindow.__skillplaneOriginalFetch;
    }
  });
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(
    page.locator(
      `a[href="/skills/${harness.workspaceSlug}/${harness.publicSkillSlug}"]`,
    ),
  ).toBeVisible();
});

test("@landing mobile navigation is keyboard-operable and dismisses with Escape", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(harness.origin);
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
  await page.screenshot({
    path: resolve(evidenceDirectory, "landing-mobile-menu-keyboard-focus.png"),
    fullPage: true,
    animations: "disabled",
  });
  await page.keyboard.press("Escape");
  await expect(page.getByRole("navigation", { name: "Mobile navigation" })).toHaveCount(
    0,
  );
  await expect(
    page.getByRole("button", { name: "Open navigation menu" }),
  ).toBeFocused();
});
