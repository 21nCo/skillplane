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
vi.mock("posthog-js", () => ({ default: posthog }));

describe("PostHog browser configuration", () => {
  it("collects only explicit product events without durable browser identity", () => {
    expect(explicitProductAnalyticsConfig("https://user.skillplane.dev")).toEqual({
      api_host: "https://user.skillplane.dev",
      ui_host: "https://us.posthog.com",
      defaults: "2026-05-30",
      advanced_disable_flags: true,
      autocapture: false,
      capture_dead_clicks: false,
      capture_exceptions: false,
      capture_heatmaps: false,
      capture_pageleave: false,
      capture_pageview: false,
      capture_performance: false,
      disable_session_recording: true,
      disable_surveys: true,
      persistence: "memory",
      person_profiles: "never",
      rageclick: false,
    });
  });

  it("rejects analytics hosts outside the app CSP", () => {
    expect(() =>
      explicitProductAnalyticsConfig("https://analytics.example.test"),
    ).toThrow("PUBLIC_POSTHOG_HOST must be https://user.skillplane.dev");
  });

  it("rejects unapproved Skillplane hosts instead of widening the CSP allowlist", () => {
    expect(() =>
      explicitProductAnalyticsConfig("https://analytics.skillplane.dev"),
    ).toThrow("PUBLIC_POSTHOG_HOST must be https://user.skillplane.dev");
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
    });
  });
});
