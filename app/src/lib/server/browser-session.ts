import { error } from "@sveltejs/kit";
import type { BrowserSession } from "$lib/auth/client.js";
import { api, runtimeBindings } from "$lib/server/api.js";

interface SessionEnvelope {
  readonly ok: boolean;
  readonly data?: {
    readonly session?: BrowserSession | null;
  };
}

interface BrowserSessionRequest {
  readonly platform: App.Platform | undefined;
  readonly request: Request;
  readonly url: URL;
}

export function hasWorkerDatabaseBinding(
  bindings: App.Platform["env"] | undefined,
): boolean {
  return Boolean(
    bindings &&
    (bindings.HYPERDRIVE ?? bindings.CONTROL_HYPERDRIVE ?? bindings.DATABASE_URL),
  );
}

export async function loadBrowserSession({
  platform,
  request,
  url,
}: BrowserSessionRequest): Promise<BrowserSession | null> {
  const headers = new Headers({ accept: "application/json" });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);

  const authRequest = new Request(new URL("/auth/session", url), {
    method: "GET",
    headers,
  });
  const workerBindings = platform?.env;
  const hasDatabaseBinding = hasWorkerDatabaseBinding(workerBindings);
  const response =
    hasDatabaseBinding && platform
      ? await api.fetch(authRequest, runtimeBindings(platform))
      : await globalThis.fetch(authRequest);

  if (!response.ok) {
    error(503, {
      code: "AUTH_SESSION_UNAVAILABLE",
      message: "Your session could not be verified. Please try again.",
    });
  }

  let envelope: SessionEnvelope;
  try {
    envelope = (await response.json()) as SessionEnvelope;
  } catch {
    error(503, {
      code: "AUTH_SESSION_INVALID",
      message: "Your session could not be verified. Please try again.",
    });
  }

  return envelope.ok ? (envelope.data?.session ?? null) : null;
}
