import type { Handle } from "@sveltejs/kit";

export const handle: Handle = async ({ event, resolve }) => {
  const response = await resolve(event);
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  response.headers.set("cross-origin-opener-policy", "same-origin");
  if (!response.headers.has("cache-control")) {
    response.headers.set("cache-control", "public, max-age=0, must-revalidate");
  }
  return response;
};
