import { env as publicEnv } from "$env/dynamic/public";
import { applyMarkdownRendererEnv } from "@skillplane/ui";
import { api, runtimeBindings } from "$lib/server/api.js";
import { withBrowserSecurityHeaders } from "$lib/server/security-headers.js";
import type { Handle } from "@sveltejs/kit";

const RENDERER_FLAGS = ["PUBLIC_SKILLPLANE_MDFN_RENDERER"] as const;

function rendererBindings(
  source: object | undefined,
): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  if (!source) return values;
  for (const key of RENDERER_FLAGS) {
    const value = Reflect.get(source, key) as unknown;
    if (typeof value === "string") values[key] = value;
  }
  return values;
}

export const handle: Handle = async ({ event, resolve }) => {
  applyMarkdownRendererEnv({
    ...rendererBindings(publicEnv),
    ...rendererBindings(event.platform?.env),
  });

  const pathname = event.url.pathname;
  if (
    pathname.startsWith("/auth/") ||
    pathname.startsWith("/datafn/") ||
    pathname.startsWith("/.well-known/")
  ) {
    return api.fetch(event.request, runtimeBindings(event.platform));
  }

  return withBrowserSecurityHeaders(await resolve(event));
};
