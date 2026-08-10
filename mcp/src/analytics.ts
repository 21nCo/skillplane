import { decodeSessionId, PostHog } from "@posthog/mcp";
import type { RuntimeBindings } from "@skillplane/config";

export function isPostHogSessionId(value: string): boolean {
  return decodeSessionId(value) !== null;
}

export function createPostHogResolver(
  configuredPostHog: PostHog | null | undefined,
): (bindings: RuntimeBindings) => PostHog | null {
  if (configuredPostHog !== undefined) {
    return () => configuredPostHog;
  }

  let cached:
    | {
        readonly token: string;
        readonly host: string;
        readonly client: PostHog | null;
      }
    | undefined;

  return (bindings) => {
    const token = bindings.POSTHOG_PROJECT_TOKEN?.trim();
    const host = bindings.POSTHOG_HOST?.trim();
    if (!token || !host) return null;
    if (cached?.token === token && cached.host === host) return cached.client;

    try {
      const client = new PostHog(token, {
        host,
        enableExceptionAutocapture: true,
      });
      cached = { token, host, client };
      return client;
    } catch {
      console.error(
        JSON.stringify({
          component: "mcp",
          event: "mcp.posthog.initialize.failed",
        }),
      );
      cached = { token, host, client: null };
      return null;
    }
  };
}

export async function flushPostHog(
  posthog: PostHog,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<void> {
  const flush = posthog.flush().catch(() => {
    console.error(
      JSON.stringify({
        component: "mcp",
        event: "mcp.posthog.flush.failed",
      }),
    );
  });
  if (waitUntil) {
    try {
      waitUntil(flush);
      return;
    } catch {
      // Test and non-Worker runtimes do not always expose a live waitUntil.
    }
  }
  await flush;
}
