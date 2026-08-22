import { browser, dev } from "$app/environment";
import { env } from "$env/dynamic/public";
import type { EventName, PostHog, Properties } from "posthog-js";
import { explicitProductAnalyticsConfig } from "./posthog.config.js";

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
      posthog.init(projectKey, explicitProductAnalyticsConfig(env.PUBLIC_POSTHOG_HOST));
      return posthog;
    })
    .catch((cause: unknown) => {
      console.error("PostHog analytics initialization failed.", cause);
      initialization = undefined;
      return undefined;
    });

  return initialization;
}

export function capturePostHog(event: EventName, properties?: Properties): void {
  void initializePostHog()
    .then((posthog) => {
      posthog?.capture(event, properties);
    })
    .catch((cause: unknown) => {
      console.error("PostHog event capture failed.", cause);
    });
}

export function resetPostHog(): void {
  void initializePostHog()
    .then((posthog) => {
      posthog?.reset();
    })
    .catch((cause: unknown) => {
      console.error("PostHog analytics reset failed.", cause);
    });
}
