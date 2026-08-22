#!/usr/bin/env node

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  developmentIssuer,
  developmentResource,
} from "./lib/development-deployment.mjs";

function assert(value, message) {
  if (!value) throw new Error(message);
}

async function request(url, expected) {
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

export async function smokeDevelopment() {
  const ready = await request(`${developmentIssuer}/api/v1/health/ready`, [200]);
  const readiness = await json(ready, "Development readiness");
  assert(readiness.ok === true, "Development app is not ready");

  const authorization = await json(
    await request(`${developmentIssuer}/.well-known/oauth-authorization-server`, [200]),
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
    await request(resourceMetadataUrl, [200]),
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
      "mcp.dev.skillplane.dev/.well-known/oauth-protected-resource/mcp",
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

if (fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.stdout.write(`${JSON.stringify(await smokeDevelopment(), null, 2)}\n`);
}
