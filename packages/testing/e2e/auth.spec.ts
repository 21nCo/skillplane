import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import {
  startAuthBrowserHarness,
  type AuthBrowserHarness,
} from "../src/auth-browser-harness.js";

let harness: AuthBrowserHarness;
const screenshotDirectory = resolve(
  process.cwd(),
  ".conduct",
  "screenshots",
  "phase-03",
);

test.beforeAll(async () => {
  await mkdir(screenshotDirectory, { recursive: true });
  harness = await startAuthBrowserHarness();
});

test.afterAll(async () => {
  await harness.close();
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const widgets = new Map<
      string,
      {
        callback: (token: string) => void;
      }
    >();
    let sequence = 0;
    Object.defineProperty(window, "turnstile", {
      configurable: true,
      value: {
        render(
          container: HTMLElement,
          options: {
            callback: (token: string) => void;
            "expired-callback": () => void;
          },
        ) {
          sequence += 1;
          const id = `e2e-widget-${sequence}`;
          widgets.set(id, { callback: options.callback });
          container.textContent = "Security check complete";
          queueMicrotask(() => options.callback("turnstile-pass"));
          return id;
        },
        reset(id: string) {
          const widget = widgets.get(id);
          if (widget) queueMicrotask(() => widget.callback("turnstile-pass"));
        },
        remove(id: string) {
          widgets.delete(id);
        },
      },
    });
  });
});

test("@auth recovers safely when verification context is missing", async ({ page }) => {
  await page.goto(`${harness.origin}/verify`);
  await expect(
    page.getByRole("heading", { name: "Start with your email" }),
  ).toBeVisible();
  await expect(page.getByRole("link", { name: /Back to sign in/ })).toHaveAttribute(
    "href",
    "/sign-in",
  );
});

test("@auth completes OTP sign-in and persists the session after reload", async ({
  page,
}) => {
  await page.goto(`${harness.origin}/sign-in`);
  await page.getByLabel("Work email").fill(harness.email);
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeEnabled();
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page).toHaveURL(`${harness.origin}/verify`);
  expect(harness.messages).toHaveLength(1);
  expect(JSON.stringify(harness.messages[0])).toContain(harness.code);

  await page.getByRole("textbox", { name: "Verification code" }).fill(harness.code);
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(page).toHaveURL(`${harness.origin}/`);

  const firstSession = await page.evaluate(async () => {
    const response = await fetch("/auth/session", { credentials: "include" });
    return response.json();
  });
  expect(firstSession).toMatchObject({
    ok: true,
    data: {
      session: {
        actorType: "user",
        subject: { email: harness.email },
      },
    },
  });

  await page.reload();
  const reloadedSession = await page.evaluate(async () => {
    const response = await fetch("/auth/session", { credentials: "include" });
    return response.json();
  });
  expect(reloadedSession).toMatchObject({
    ok: true,
    data: { session: { actorType: "user" } },
  });
});

test("@auth renders invalid, expired, and rate-limit states in both themes", async ({
  page,
}) => {
  await page.goto(`${harness.origin}/sign-in`);
  await expect(page.locator(".risk-ready")).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
    localStorage.setItem("skillplane.theme", "dark");
  });
  await page.screenshot({
    path: resolve(screenshotDirectory, "sign-in-dark.png"),
    fullPage: true,
  });
  await page.getByRole("button", { name: "Use light theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await expect(
    page.getByRole("heading", { name: "Give every agent the right skill" }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({
    path: resolve(screenshotDirectory, "sign-in-light.png"),
    fullPage: true,
  });

  await page.getByLabel("Work email").fill(harness.email);
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.getByRole("textbox", { name: "Verification code" }).fill("999999");
  await page.getByRole("button", { name: "Verify and continue" }).click();
  await expect(
    page.getByText("That code is not valid. Check the email and try again."),
  ).toBeVisible();
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await page.screenshot({
    path: resolve(screenshotDirectory, "verify-invalid-dark.png"),
    fullPage: true,
  });

  await page.evaluate(() => {
    const raw = sessionStorage.getItem("skillplane.auth.otp");
    if (!raw) throw new Error("OTP context is missing");
    const context = JSON.parse(raw) as { expiresAt: number };
    context.expiresAt = Date.now() - 1_000;
    sessionStorage.setItem("skillplane.auth.otp", JSON.stringify(context));
    localStorage.setItem("skillplane.theme", "light");
  });
  await page.reload();
  await expect(
    page.getByText("This code has expired. Request a new one to continue."),
  ).toBeVisible();
  await page.screenshot({
    path: resolve(screenshotDirectory, "verify-expired-light.png"),
    fullPage: true,
  });

  await expect(page.getByRole("button", { name: "Send a new code" })).toBeEnabled();
  await page.getByRole("button", { name: "Send a new code" }).click();
  await expect(page.getByText(/Too many requests/)).toBeVisible();
  expect(harness.messages).toHaveLength(2);
  await page.screenshot({
    path: resolve(screenshotDirectory, "verify-rate-limit-light.png"),
    fullPage: true,
  });
});
