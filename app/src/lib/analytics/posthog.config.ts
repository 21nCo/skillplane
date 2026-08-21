import type { PostHogConfig } from "posthog-js";

const defaultPostHogHost = "https://us.i.posthog.com";

export function explicitProductAnalyticsConfig(
  apiHost: string | undefined,
): Partial<PostHogConfig> {
  return {
    api_host: apiHost ?? defaultPostHogHost,
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
  };
}
