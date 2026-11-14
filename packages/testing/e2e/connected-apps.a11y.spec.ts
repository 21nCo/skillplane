import AxeBuilder from "@axe-core/playwright";
import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type Route,
} from "@playwright/test";
import {
  startWorkspaceBrowserHarness,
  type WorkspaceBrowserHarness,
} from "./support/workspace-browser-harness.js";

const CONNECTIONS = "/api/v1/me/oauth-connections";

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

const connections = [
  {
    consentId: "ocn_a11y_review",
    clientId: "spclient_a11y_review_with_a_long_identifier_that_must_wrap",
    clientName: "Review agent",
    resource: "https://mcp.example.test/mcp",
    scopes: ["skills:read", "skills:write", "skills:amend", "contexts:read"],
    grantedAt: "2026-11-12T09:30:00.000Z",
    lastTokenIssuedAt: "2026-11-13T16:05:00.000Z",
  },
  {
    consentId: "ocn_a11y_docs",
    clientId: "spclient_a11y_docs",
    clientName: "Docs agent",
    resource: "https://mcp.example.test/mcp",
    scopes: ["contexts:read"],
    grantedAt: "2026-11-10T08:00:00.000Z",
    lastTokenIssuedAt: null,
  },
] as const;

type ListMode = "list" | "empty" | "error";

async function stubConnections(page: Page, mode: () => ListMode): Promise<void> {
  await page.route(`**${CONNECTIONS}`, async (route: Route) => {
    const current = mode();
    await route.fulfill(
      current === "error"
        ? {
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({
              ok: false,
              error: {
                code: "SERVICE_UNAVAILABLE",
                message: "Skillplane is temporarily unavailable.",
                requestId: "req_a11y",
              },
            }),
          }
        : {
            status: 200,
            contentType: "application/json",
            body: JSON.stringify({
              ok: true,
              data: { connections: current === "list" ? connections : [] },
              meta: { requestId: "req_a11y" },
            }),
          },
    );
  });
  await page.route(`**${CONNECTIONS}/*`, async (route: Route) => {
    await route.fulfill({ status: 204 });
  });
}

test.beforeAll(async () => {
  harness = await startWorkspaceBrowserHarness();
});

test.afterAll(async () => {
  await harness?.close();
});

test("@connected-apps-a11y passes list, empty, error and dialog states across themes, viewports and keyboard", async ({
  context,
  page,
}) => {
  test.setTimeout(180_000);
  await authenticate(context);
  let mode: ListMode = "list";
  await stubConnections(page, () => mode);
  await page.goto(`${harness.origin}/workspaces`);

  const states = [
    {
      mode: "list",
      ready: () => page.getByRole("button", { name: "Revoke Review agent" }),
    },
    {
      mode: "empty",
      ready: () => page.getByRole("heading", { name: "No connected apps" }),
    },
    {
      mode: "error",
      ready: () =>
        page.getByRole("heading", { name: "Connected apps could not be loaded" }),
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
      for (const state of states) {
        mode = state.mode;
        await page.goto(`${harness.origin}/account/connected-apps`);
        await expect(state.ready()).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await assertAccessible(
          page,
          `connected-apps-${state.mode}-${theme}-${String(viewport.width)}`,
        );
      }
    }
  }

  // Keyboard only: reach the page from the account menu, cancel a revoke with
  // Escape, then revoke both rows.
  mode = "list";
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`${harness.origin}/workspaces`);
  const account = page.getByRole("button", { name: "Account" });
  await account.focus();
  await page.keyboard.press("Enter");
  // The signed-in identity is a disabled first item; focus skips it.
  const menuItem = page.getByRole("menuitem", { name: /Connected apps/u });
  await expect(menuItem).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("menuitem", { name: /Sign out/u })).toBeFocused();
  await page.keyboard.press("ArrowDown");
  await expect(menuItem).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(`${harness.origin}/account/connected-apps`);

  const reviewRevoke = page.getByRole("button", { name: "Revoke Review agent" });
  const docsRevoke = page.getByRole("button", { name: "Revoke Docs agent" });
  await expect(reviewRevoke).toBeVisible();
  await reviewRevoke.focus();
  await page.keyboard.press("Enter");
  const reviewDialog = page.getByRole("dialog", { name: "Revoke Review agent?" });
  await expect(reviewDialog).toBeVisible();
  // The safe choice is focused first in a destructive confirmation.
  await expect(reviewDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await assertAccessible(page, "connected-apps-revoke-dialog");
  await page.keyboard.press("Escape");
  await expect(reviewDialog).toBeHidden();
  await expect(reviewRevoke).toBeFocused();

  await page.keyboard.press("Enter");
  await expect(reviewDialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(
    reviewDialog.getByRole("button", { name: "Revoke access" }),
  ).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(reviewRevoke).toHaveCount(0);
  await expect(docsRevoke).toBeFocused();

  await page.keyboard.press("Enter");
  const docsDialog = page.getByRole("dialog", { name: "Revoke Docs agent?" });
  await page.keyboard.press("Tab");
  await expect(docsDialog.getByRole("button", { name: "Revoke access" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "No connected apps" })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Connected apps", level: 1 }),
  ).toBeFocused();
  await assertAccessible(page, "connected-apps-after-keyboard-revoke");
});
