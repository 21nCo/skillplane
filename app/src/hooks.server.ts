import { api, runtimeBindings } from "$lib/server/api.js";
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
