import { browser, dev } from "$app/environment";
import { env } from "$env/dynamic/public";
import type { PostHog } from "posthog-js";

let client: PostHog | undefined;
let initialization: Promise<PostHog | undefined> | undefined;
let missingKeyWarned = false;

export function initializePostHog(): Promise<PostHog | undefined> {
  if (!browser) return Promise.resolve(undefined);

  const projectKey = env.PUBLIC_POSTHOG_KEY;
  if (!projectKey) {
    if (dev && !missingKeyWarned) {
      console.warn(
        "PostHog analytics are disabled because PUBLIC_POSTHOG_KEY is not configured.",
      );
      missingKeyWarned = true;
    }
    return Promise.resolve(undefined);
  }

  initialization ??= import("posthog-js")
    .then(({ default: posthog }) => {
      posthog.init(projectKey, {
        api_host: env.PUBLIC_POSTHOG_HOST ?? "https://us.i.posthog.com",
        defaults: "2026-05-30",
        capture_exceptions: {
          capture_unhandled_errors: true,
          capture_unhandled_rejections: true,
          capture_console_errors: false,
        },
      });
      client = posthog;
      return client;
    })
    .catch((cause: unknown) => {
      console.error("PostHog analytics initialization failed.", cause);
      initialization = undefined;
      return undefined;
    });

  return initialization;
}

export function getPostHog(): PostHog | undefined {
  return client;
}
