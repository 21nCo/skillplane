import { describe, expect, it, vi } from "vitest";
import { explicitProductAnalyticsConfig } from "../../src/lib/analytics/posthog.config.js";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  init: vi.fn(),
  reset: vi.fn(),
}));

vi.mock("$app/environment", () => ({ browser: true, dev: false }));
vi.mock("$env/dynamic/public", () => ({
  env: {
    PUBLIC_POSTHOG_HOST: "https://user.skillplane.dev",
    PUBLIC_POSTHOG_KEY: "phc_test_project_key",
  },
}));
vi.mock("posthog-js/dist/module.full.no-external", () => ({ default: posthog }));

describe("PostHog browser configuration", () => {
  it("enables product analytics, web analytics, error tracking, and replay", () => {
    expect(explicitProductAnalyticsConfig("https://user.skillplane.dev")).toEqual({
      api_host: "https://user.skillplane.dev",
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      advanced_disable_flags: false,
      autocapture: true,
      capture_dead_clicks: true,
      capture_exceptions: true,
      capture_heatmaps: true,
      capture_pageleave: "if_capture_pageview",
      capture_pageview: "history_change",
      capture_performance: true,
      disable_external_dependency_loading: true,
      disable_session_recording: false,
      disable_surveys: false,
      persistence: "localStorage+cookie",
      person_profiles: "identified_only",
      rageclick: true,
      session_recording: {
        maskAllInputs: true,
      },
    });
  });

  it("rejects analytics hosts outside the app CSP", () => {
    expect(() =>
      explicitProductAnalyticsConfig("https://analytics.example.test"),
    ).toThrow("PUBLIC_POSTHOG_HOST must be an approved Skillplane proxy");
  });

  it("rejects unapproved Skillplane hosts instead of widening the CSP allowlist", () => {
    expect(() =>
      explicitProductAnalyticsConfig("https://analytics.skillplane.dev"),
    ).toThrow("PUBLIC_POSTHOG_HOST must be an approved Skillplane proxy");
  });

  it("allows the isolated development PostHog proxy", () => {
    expect(
      explicitProductAnalyticsConfig("https://user-dev.skillplane.dev").api_host,
    ).toBe("https://user-dev.skillplane.dev");
  });

  it("queues event capture and reset while the browser SDK initializes", async () => {
    const { capturePostHog, resetPostHog } =
      await import("../../src/lib/analytics/posthog.client.js");

    capturePostHog("workspace_switched");
    expect(resetPostHog()).toBeUndefined();

    await vi.waitFor(() => {
      expect(posthog.init).toHaveBeenCalledOnce();
      expect(posthog.capture).toHaveBeenCalledWith("workspace_switched", undefined);
      expect(posthog.reset).toHaveBeenCalledOnce();
      expect(posthog.reset).toHaveBeenCalledWith(true);
    });
  });
});
