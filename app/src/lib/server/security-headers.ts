export function withBrowserSecurityHeaders(source: Response): Response {
  // Responses returned through a Cloudflare service binding have immutable
  // headers. Clone the response before SvelteKit adds browser policy headers.
  const response = new Response(source.body, source);
  response.headers.set("referrer-policy", "strict-origin-when-cross-origin");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set(
    "permissions-policy",
    "camera=(), microphone=(), geolocation=(), payment=()",
  );
  return response;
}
