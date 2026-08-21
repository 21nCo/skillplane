import { describe, expect, it, vi } from "vitest";
import { explicitProductAnalyticsConfig } from "../../src/lib/analytics/posthog.config.js";

const posthog = vi.hoisted(() => ({
  capture: vi.fn(),
  init: vi.fn(),
}));

vi.mock("$app/environment", () => ({ browser: true, dev: false }));
vi.mock("$env/dynamic/public", () => ({
  env: {
    PUBLIC_POSTHOG_HOST: "https://analytics.example.test",
    PUBLIC_POSTHOG_KEY: "phc_test_project_key",
  },
}));
vi.mock("posthog-js", () => ({ default: posthog }));

describe("PostHog browser configuration", () => {
  it("collects only explicit product events without durable browser identity", () => {
    expect(explicitProductAnalyticsConfig("https://analytics.example.test")).toEqual({
      api_host: "https://analytics.example.test",
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

  it("retains an explicit event while the browser SDK initializes", async () => {
    const { capturePostHog } =
      await import("../../src/lib/analytics/posthog.client.js");

    capturePostHog("workspace_switched");

    await vi.waitFor(() => {
      expect(posthog.init).toHaveBeenCalledOnce();
      expect(posthog.capture).toHaveBeenCalledWith("workspace_switched", undefined);
    });
  });
});
