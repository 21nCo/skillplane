import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import("@sveltejs/kit").Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    // OAuth token and revocation endpoints must accept originless form posts from
    // native and server-side MCP clients. Cookie-authorized mutations remain
    // protected by AuthFn consent CSRF and the API's cookie-CSRF middleware.
    csrf: {
      trustedOrigins: ["*"],
    },
    csp: {
      mode: "hash",
      directives: {
        "default-src": ["self"],
        "script-src": ["self", "https://challenges.cloudflare.com"],
        "style-src": ["self", "unsafe-inline"],
        "img-src": ["self", "data:"],
        "font-src": ["self"],
        "connect-src": ["self", "https://challenges.cloudflare.com"],
        "frame-src": ["https://challenges.cloudflare.com"],
        "object-src": ["none"],
        "base-uri": ["self"],
        "form-action": ["self"],
        "frame-ancestors": ["none"],
      },
    },
  },
};

export default config;
