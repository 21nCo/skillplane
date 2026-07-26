import { error, redirect } from "@sveltejs/kit";
import type { BrowserSession } from "$lib/auth/client.js";
import { api, runtimeBindings } from "$lib/server/api.js";
import type { LayoutServerLoad } from "./$types";

interface SessionEnvelope {
  readonly ok: boolean;
  readonly data?: {
    readonly session?: BrowserSession | null;
  };
}

export const load: LayoutServerLoad = async ({ platform, request, url }) => {
  const headers = new Headers({ accept: "application/json" });
  const cookie = request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const authRequest = new Request(new URL("/auth/session", url), {
    method: "GET",
    headers,
  });
  const workerPlatform: App.Platform | undefined = platform;
  const workerBindings = workerPlatform === undefined ? undefined : workerPlatform.env;
  const hasWorkerDatabaseBinding = Boolean(
    workerBindings && (workerBindings.HYPERDRIVE ?? workerBindings.DATABASE_URL),
  );
  const response =
    hasWorkerDatabaseBinding && workerPlatform
      ? await api.fetch(authRequest, runtimeBindings(workerPlatform))
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

  const session = envelope.data?.session;
  if (!envelope.ok || !session) {
    const returnTo = `${url.pathname}${url.search}`;
    redirect(303, `/sign-in?next=${encodeURIComponent(returnTo)}`);
  }

  return { session };
};
