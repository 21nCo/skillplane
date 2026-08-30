import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  immutableAssetUrl,
  productionReleaseSmoke,
  productionTopologySmoke,
} from "./production-smoke.mjs";

const icon = Buffer.alloc(1_024, 7);
const favicon = Buffer.alloc(128, 8);
const noStoreHeaders = {
  "cache-control": "private, no-store",
  "content-type": "application/json",
};

function response(url, body, init = {}) {
  const result = new Response(body, init);
  Object.defineProperty(result, "url", { value: url });
  return result;
}

function jsonResponse(url, body, init = {}) {
  return response(url, JSON.stringify(body), {
    ...init,
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
}

function productionFetch(calls) {
  return async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url: url.toString(), method: init.method ?? "GET" });

    if (url.hostname === "skillplane.dev") {
      if (url.pathname === "/") {
        return response(
          url.toString(),
          '<main>Skills that self-improve</main><script src="/_app/immutable/start.js"></script>',
          { headers: { "cache-control": "public, max-age=60" } },
        );
      }
      if (url.pathname === "/_app/immutable/start.js") {
        return response(url.toString(), "export {};", {
          headers: { "cache-control": "public, max-age=31536000, immutable" },
        });
      }
      if (url.pathname === "/icon-512.png") {
        return response(url.toString(), icon, {
          headers: { "content-type": "image/png" },
        });
      }
    }

    if (url.hostname === "app.skillplane.dev") {
      if (url.pathname === "/") {
        return response(url.toString(), "<title>Sign in · Skillplane</title>");
      }
      if (url.pathname === "/icon-512.png") {
        return response(url.toString(), icon, {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname === "/api/v1/health/live") {
        return jsonResponse(
          url.toString(),
          { ok: true, data: { status: "live" } },
          { headers: noStoreHeaders },
        );
      }
      if (url.pathname === "/api/v1/health/ready") {
        return jsonResponse(
          url.toString(),
          {
            ok: true,
            data: {
              status: "ready",
              checks: {
                configuration: { code: "CONFIG_VALID" },
                postgres: { code: "POSTGRES_READY" },
                objectStorage: { code: "R2_READY" },
              },
            },
          },
          { headers: noStoreHeaders },
        );
      }
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return jsonResponse(
          url.toString(),
          {
            issuer: "https://app.skillplane.dev",
            authorization_endpoint: "https://app.skillplane.dev/auth/oauth/authorize",
            token_endpoint: "https://app.skillplane.dev/auth/oauth/token",
            registration_endpoint: "https://app.skillplane.dev/auth/oauth/register",
            code_challenge_methods_supported: ["S256"],
          },
          { headers: noStoreHeaders },
        );
      }
      if (url.pathname === "/auth/oauth/token") {
        return jsonResponse(
          url.toString(),
          { error: "invalid_client" },
          { status: 401, headers: noStoreHeaders },
        );
      }
      if (url.pathname === "/datafn/query") {
        return response(url.toString(), "", {
          status: 401,
          headers: noStoreHeaders,
        });
      }
    }

    if (url.hostname === "mcp.skillplane.dev") {
      if (url.pathname === "/") {
        return response(
          url.toString(),
          '<title>Skillplane MCP</title><link href="/favicon.ico">',
        );
      }
      if (url.pathname === "/icon-512.png") {
        return response(url.toString(), icon, {
          headers: { "content-type": "image/png" },
        });
      }
      if (url.pathname === "/favicon.ico") {
        return response(url.toString(), favicon, {
          headers: { "content-type": "image/x-icon" },
        });
      }
      if (url.pathname === "/mcp") {
        return response(url.toString(), "", {
          status: 401,
          headers: {
            "cache-control": "private, no-store",
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.skillplane.dev/.well-known/oauth-protected-resource/mcp", error="invalid_token"',
          },
        });
      }
    }

    if (
      url.pathname === "/.well-known/oauth-protected-resource/mcp" &&
      ["app.skillplane.dev", "mcp.skillplane.dev"].includes(url.hostname)
    ) {
      return jsonResponse(
        url.toString(),
        {
          resource: "https://mcp.skillplane.dev/mcp",
          authorization_servers: ["https://app.skillplane.dev"],
          scopes_supported: [
            "skills:read",
            "skills:write",
            "skills:amend",
            "skills:publish",
            "contexts:write",
          ],
        },
        { headers: noStoreHeaders },
      );
    }

    assert.fail(`Unexpected production smoke request: ${init.method ?? "GET"} ${url}`);
  };
}

async function withFetch(mock, operation) {
  const original = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await operation();
  } finally {
    globalThis.fetch = original;
  }
}

describe("production smoke immutable asset discovery", () => {
  it("resolves root-relative SvelteKit assets", () => {
    assert.equal(
      immutableAssetUrl(
        '<link href="/_app/immutable/assets/app.css" rel="stylesheet">',
        "https://skillplane.dev/",
      ),
      "https://skillplane.dev/_app/immutable/assets/app.css",
    );
  });

  it("resolves adapter-cloudflare relative SvelteKit assets", () => {
    assert.equal(
      immutableAssetUrl(
        '<script src="./_app/immutable/entry/start.js"></script>',
        "https://skillplane.dev/",
      ),
      "https://skillplane.dev/_app/immutable/entry/start.js",
    );
  });

  it("rejects pages without immutable assets", () => {
    assert.equal(
      immutableAssetUrl("<main>Skillplane</main>", "https://skillplane.dev/"),
      undefined,
    );
  });
});

describe("production smoke ownership boundaries", { concurrency: false }, () => {
  it("keeps the blocking release smoke scoped to app and MCP", async () => {
    const calls = [];
    const result = await withFetch(productionFetch(calls), () =>
      productionReleaseSmoke(),
    );

    assert.equal(result.scope, "app-mcp-release");
    assert.deepEqual(Object.keys(result.hosts).sort(), ["app", "mcp"]);
    assert.equal(
      calls.some(({ url }) => new URL(url).hostname === "skillplane.dev"),
      false,
    );
  });

  it("checks the independently deployed landing host only in topology smoke", async () => {
    const calls = [];
    const result = await withFetch(productionFetch(calls), () =>
      productionTopologySmoke(),
    );

    assert.equal(result.scope, "production-topology");
    assert.equal(result.hosts.landing.status, 200);
    assert.equal(result.boundaries.landingAppMcpBrandConsistent, true);
    assert.equal(
      calls.some(({ url }) => new URL(url).hostname === "skillplane.dev"),
      true,
    );
  });
});
