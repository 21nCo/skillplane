#!/usr/bin/env node

import {
  developmentIssuer,
  developmentResource,
  verifiedDevelopmentCloudflareEnvironment,
} from "./lib/development-deployment.mjs";
import { isMain } from "./lib/production-deployment.mjs";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function request(fetch, url, expected) {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!expected.includes(response.status)) {
    throw new Error(`${new URL(url).pathname} returned HTTP ${response.status}`);
  }
  return response;
}

async function json(response, label) {
  return response.json().catch(() => {
    throw new Error(`${label} did not return JSON`);
  });
}

// `options.fetch` replaces the global fetch for the account listing and every
// smoke request alike.
export async function smokeDevelopment(options = {}) {
  const fetch = options.fetch ?? globalThis.fetch;
  await verifiedDevelopmentCloudflareEnvironment({ fetch });
  const ready = await request(fetch, `${developmentIssuer}/api/v1/health/ready`, [200]);
  const readiness = await json(ready, "Development readiness");
  assert(readiness.ok === true, "Development app is not ready");

  const authorization = await json(
    await request(
      fetch,
      `${developmentIssuer}/.well-known/oauth-authorization-server`,
      [200],
    ),
    "Development OAuth metadata",
  );
  assert(
    authorization.issuer === developmentIssuer,
    "Development OAuth issuer is wrong",
  );

  const resourceMetadataUrl = new URL(
    "/.well-known/oauth-protected-resource/mcp",
    developmentResource,
  );
  const protectedResource = await json(
    await request(fetch, resourceMetadataUrl, [200]),
    "Development protected-resource metadata",
  );
  assert(
    protectedResource.resource === developmentResource &&
      protectedResource.authorization_servers?.[0] === developmentIssuer,
    "Development MCP OAuth discovery is inconsistent",
  );

  const unauthorized = await fetch(developmentResource, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "development-smoke",
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "skillplane-development-smoke", version: "1.0.0" },
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  assert(
    unauthorized.status === 401,
    "Development MCP accepted an unauthenticated request",
  );
  const challenge = unauthorized.headers.get("www-authenticate") ?? "";
  assert(
    challenge.includes(
      "skillplane-mcp.21n.dev/.well-known/oauth-protected-resource/mcp",
    ),
    "Development MCP challenge points at the wrong resource metadata",
  );
  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    environment: "development",
    issuer: developmentIssuer,
    resource: developmentResource,
    readiness: true,
    oauthDiscovery: true,
    mcpAuthenticationRequired: true,
  };
}

if (isMain(import.meta.url)) {
  process.stdout.write(`${JSON.stringify(await smokeDevelopment(), null, 2)}\n`);
}
