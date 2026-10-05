import adapter from "@sveltejs/adapter-cloudflare";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";
import { readFileSync } from "node:fs";

const topologyFiles = [
  new URL("../deployment/topology.production.json", import.meta.url),
  new URL("../deployment/topology.development.json", import.meta.url),
];
const datafnOrigins = [
  ...new Set(
    topologyFiles.flatMap((path) => {
      const topology = JSON.parse(readFileSync(path, "utf8"));
      return topology.cells.flatMap((cell) =>
        cell.datafnEndpoint ? [new URL(cell.datafnEndpoint.httpUrl).origin] : [],
      );
    }),
  ),
];

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
        "connect-src": [
          "self",
          ...datafnOrigins,
          "https://challenges.cloudflare.com",
          // posthog.config.ts restricts PUBLIC_POSTHOG_HOST to these HTTPS domains.
          "https://user.skillplane.dev",
          "https://user-dev.skillplane.dev",
          "https://*.posthog.com",
        ],
        "worker-src": ["self", "blob:", "data:"],
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
