import { api, runtimeBindings } from "$lib/server/api.js";
import { withBrowserSecurityHeaders } from "$lib/server/security-headers.js";
import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
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
