import { env as publicEnv } from "$env/dynamic/public";
import { applyMarkdownRendererEnv } from "@skillplane/ui";
import { api, runtimeBindings } from "$lib/server/api.js";
import type { Handle } from "@sveltejs/kit";

function stringBindings(
  source: object | undefined,
): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  if (!source) return values;
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

export const handle: Handle = async ({ event, resolve }) => {
  applyMarkdownRendererEnv({
    ...publicEnv,
    ...stringBindings(event.platform?.env),
  });

  const pathname = event.url.pathname;
  if (
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/datafn/") ||
    pathname.startsWith("/.well-known/")
  ) {
    return api.fetch(event.request, runtimeBindings(event.platform));
  }

  const response = await resolve(event);
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  return response;
};
