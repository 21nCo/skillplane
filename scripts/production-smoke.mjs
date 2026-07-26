#!/usr/bin/env node

import {
  isMain,
  productionIssuer,
  productionResource,
} from "./lib/production-deployment.mjs";

const endpoints = Object.freeze({
  landing: "https://skillplane.dev",
  app: productionIssuer,
  mcp: "https://mcp.skillplane.dev",
});

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function request(url, init = {}, options = {}) {
  const attempts = options.attempts ?? 1;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        redirect: "follow",
        ...init,
        signal: AbortSignal.timeout(options.timeoutMilliseconds ?? 10_000),
      });
      if (options.acceptStatus && !options.acceptStatus.includes(response.status)) {
        throw new Error(`${new URL(url).pathname} returned ${response.status}`);
      }
      return response;
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
    }
  }
  throw lastError;
}

function assertTls(response, host) {
  const final = new URL(response.url);
  assert(final.protocol === "https:", `${host} did not remain on TLS`);
  assert(final.hostname === host, `${host} redirected to an unexpected host`);
}

function assertNoStore(response, label) {
  const value = response.headers.get("cache-control") ?? "";
  assert(
    /(?:^|,)\s*(?:private,\s*)?no-store(?:,|$)/iu.test(value) ||
      value.toLowerCase().includes("no-store"),
    `${label} is not marked no-store`,
  );
}

async function readJson(response, label) {
  const contentType = response.headers.get("content-type") ?? "";
  assert(contentType.includes("application/json"), `${label} is not JSON`);
  try {
    return await response.json();
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
}

export async function productionSmoke(options = {}) {
  const attempts = options.attempts ?? 1;
  const landing = await request(
    endpoints.landing,
    {},
    {
      attempts,
      acceptStatus: [200],
    },
  );
  const app = await request(
    endpoints.app,
    {},
    {
      attempts,
      acceptStatus: [200],
    },
  );
  assertTls(landing, "skillplane.dev");
  assertTls(app, "app.skillplane.dev");
  const [landingHtml, appHtml] = await Promise.all([landing.text(), app.text()]);
  assert(
    landingHtml.includes("Versioned skills for accountable AI agents"),
    "The landing host returned unexpected content",
  );
  assert(
    appHtml.includes("Runtime · Skillplane"),
    "The app host returned unexpected content",
  );
  assert(landingHtml !== appHtml, "Landing and app hosts returned identical content");
  assert(
    (landing.headers.get("cache-control") ?? "").startsWith("public,"),
    "The public landing page is not explicitly cacheable",
  );
  const immutablePath = /(?:src|href)="(\/_app\/immutable\/[^"]+)"/u.exec(
    landingHtml,
  )?.[1];
  assert(immutablePath, "The landing page omitted immutable assets");
  const immutableAsset = await request(
    `${endpoints.landing}${immutablePath}`,
    {},
    {
      attempts,
      acceptStatus: [200],
    },
  );
  assert(
    (immutableAsset.headers.get("cache-control") ?? "").includes("immutable"),
    "A digest-named landing asset is missing immutable caching",
  );

  const live = await request(
    `${endpoints.app}/api/v1/health/live`,
    {},
    {
      attempts,
      acceptStatus: [200],
    },
  );
  assertNoStore(live, "Liveness response");
  const liveBody = await readJson(live, "Liveness response");
  assert(
    liveBody.ok === true && liveBody.data?.status === "live",
    "The app liveness contract failed",
  );

  const ready = await request(
    `${endpoints.app}/api/v1/health/ready`,
    {},
    {
      attempts,
      acceptStatus: [200],
      timeoutMilliseconds: 15_000,
    },
  );
  assertNoStore(ready, "Readiness response");
  const readyBody = await readJson(ready, "Readiness response");
  const checks = readyBody.data?.checks;
  assert(
    readyBody.ok === true &&
      readyBody.data?.status === "ready" &&
      checks?.configuration?.code === "CONFIG_VALID" &&
      checks?.postgres?.code === "POSTGRES_READY" &&
      checks?.objectStorage?.code === "R2_READY",
    "Hyperdrive, Postgres, R2, or production configuration is not ready",
  );
  assert(
    !ready.headers.get("access-control-allow-origin"),
    "Private readiness data unexpectedly enables cross-origin access",
  );

  const authorizationMetadata = await request(
    `${endpoints.app}/.well-known/oauth-authorization-server`,
    {},
    { attempts, acceptStatus: [200] },
  );
  assertNoStore(authorizationMetadata, "OAuth metadata");
  const authorizationBody = await readJson(authorizationMetadata, "OAuth metadata");
  assert(
    authorizationBody.issuer === productionIssuer &&
      authorizationBody.authorization_endpoint ===
        `${productionIssuer}/auth/oauth/authorize` &&
      authorizationBody.token_endpoint === `${productionIssuer}/auth/oauth/token` &&
      authorizationBody.registration_endpoint ===
        `${productionIssuer}/auth/oauth/register` &&
      authorizationBody.code_challenge_methods_supported?.includes("S256"),
    "OAuth authorization server metadata is inconsistent",
  );

  for (const origin of [endpoints.app, endpoints.mcp]) {
    const metadata = await request(
      `${origin}/.well-known/oauth-protected-resource/mcp`,
      {},
      { attempts, acceptStatus: [200] },
    );
    assertNoStore(metadata, `${origin} protected-resource metadata`);
    const body = await readJson(metadata, `${origin} protected-resource metadata`);
    assert(
      body.resource === productionResource &&
        body.authorization_servers?.length === 1 &&
        body.authorization_servers[0] === productionIssuer &&
        body.scopes_supported?.includes("skills:read") &&
        body.scopes_supported?.includes("skills:amend") &&
        body.scopes_supported?.includes("contexts:write"),
      `${origin} protected-resource metadata is inconsistent`,
    );
  }

  const unauthorizedMcp = await request(
    `${endpoints.mcp}/mcp`,
    {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "production-smoke",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "skillplane-production-smoke", version: "1.0.0" },
        },
      }),
    },
    { attempts, acceptStatus: [401] },
  );
  assertNoStore(unauthorizedMcp, "Unauthorized MCP response");
  const challenge = unauthorizedMcp.headers.get("www-authenticate") ?? "";
  assert(
    challenge.startsWith("Bearer ") &&
      challenge.includes(
        'resource_metadata="https://mcp.skillplane.dev/.well-known/oauth-protected-resource/mcp"',
      ) &&
      challenge.includes('error="invalid_token"'),
    "The MCP bearer challenge is not resource-aware",
  );

  const datafn = await request(
    `${endpoints.app}/datafn/query`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resource: "skills",
        version: 1,
        select: ["id"],
        limit: 1,
      }),
    },
    { attempts, acceptStatus: [401, 403] },
  );
  assertNoStore(datafn, "Unauthenticated DataFn response");

  return {
    ok: true,
    checkedAt: new Date().toISOString(),
    hosts: {
      landing: { status: landing.status, tls: true, cache: "public" },
      app: { status: app.status, tls: true },
      mcp: { status: unauthorizedMcp.status, tls: true },
    },
    readiness: {
      configuration: checks.configuration.code,
      postgres: checks.postgres.code,
      objectStorage: checks.objectStorage.code,
    },
    oauth: {
      issuer: authorizationBody.issuer,
      resource: productionResource,
      pkce: "S256",
    },
    boundaries: {
      privateNoStore: true,
      privateCorsWildcard: false,
      publicAssetImmutable: true,
      datafnAuthenticationRequired: true,
      mcpBearerChallenge: true,
    },
  };
}

if (isMain(import.meta.url)) {
  const result = await productionSmoke();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
