import type { PostHogConfig } from "posthog-js";

const defaultPostHogHost = "https://us.i.posthog.com";

function supportedPostHogHost(apiHost: string | undefined): string {
  const configured = apiHost ?? defaultPostHogHost;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(
      "PUBLIC_POSTHOG_HOST must be an HTTPS posthog.com subdomain allowed by the app CSP.",
    );
  }
  if (
    url.protocol !== "https:" ||
    !url.hostname.endsWith(".posthog.com") ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(
      "PUBLIC_POSTHOG_HOST must be an HTTPS posthog.com subdomain allowed by the app CSP.",
    );
  }
  return url.origin;
}

export function explicitProductAnalyticsConfig(
  apiHost: string | undefined,
): Partial<PostHogConfig> {
  return {
    api_host: supportedPostHogHost(apiHost),
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
