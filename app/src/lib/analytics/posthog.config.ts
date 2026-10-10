import type { PostHogConfig } from "posthog-js/dist/module.full.no-external";

const defaultPostHogHost = "https://user.skillplane.dev";
const postHogUiHost = "https://us.posthog.com";
const skillplanePostHogProxyHosts = new Set([
  "user.skillplane.dev",
  "user-dev.skillplane.dev",
]);

const hostError =
  "PUBLIC_POSTHOG_HOST must be an approved Skillplane proxy or HTTPS posthog.com subdomain allowed by the app CSP.";

function supportedPostHogHost(apiHost: string | undefined): string {
  const configured = apiHost ?? defaultPostHogHost;
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new Error(hostError);
  }
  const supportedHostname =
    skillplanePostHogProxyHosts.has(url.hostname) ||
    url.hostname.endsWith(".posthog.com");
  if (
    url.protocol !== "https:" ||
    !supportedHostname ||
    (url.port !== "" && url.port !== "443") ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new Error(hostError);
  }
  return url.origin;
}

export function explicitProductAnalyticsConfig(
  apiHost: string | undefined,
): Partial<PostHogConfig> {
  return {
    api_host: supportedPostHogHost(apiHost),
    ui_host: postHogUiHost,
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
  };
}
