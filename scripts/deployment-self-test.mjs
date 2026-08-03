#!/usr/bin/env node

import {
  activeVersionFromDeployments,
  parseRailwayDatabaseUrl,
  requireHyperdriveId,
  sanitizeDeploymentRecord,
} from "./lib/production-deployment.mjs";
import {
  assertHyperdriveOriginRecord,
  parseWranglerJson,
} from "./lib/cloudflare-production.mjs";
import { renderDeploymentConfigs } from "./render-deploy-config.mjs";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

let missingIdRejected = false;
try {
  requireHyperdriveId("");
} catch {
  missingIdRejected = true;
}
assert(missingIdRejected, "A missing Hyperdrive ID was accepted");

const rendered = await renderDeploymentConfigs({
  hyperdriveId: "a".repeat(32),
  siteKey: "turnstile-self-test-site-key",
  write: false,
});
assert(Object.keys(rendered.configs).length === 3, "Three configs were not rendered");
assert(
  rendered.configs.landing.routing.type === "zone-route" &&
    rendered.configs.landing.routing.pattern === "skillplane.dev/*" &&
    rendered.configs.app.routing.type === "custom-domain" &&
    rendered.configs.mcp.routing.type === "custom-domain",
  "Production routing modes were not rendered correctly",
);

const railway = parseRailwayDatabaseUrl(
  "postgresql://skillplane:secret@roundhouse.proxy.rlwy.net:12345/skillplane",
  "self-test Railway URL",
);
assert(
  new URL(railway.url).searchParams.get("sslmode") === "require",
  "Railway SSL was not forced",
);
assert(
  !JSON.stringify({
    fingerprint: railway.fingerprint,
    identity: railway.identity,
  }).includes("secret"),
  "The sanitized Railway identity retained a password",
);

const railwayAlias = parseRailwayDatabaseUrl(
  "postgresql://skillplane:secret@insouth.db.21n.dev:47273/skillplane",
  "self-test approved Railway alias",
);
assert(
  railwayAlias.identity.host === "insouth.db.21n.dev" &&
    new URL(railwayAlias.url).searchParams.get("sslmode") === "require" &&
    new URL(railwayAlias.url).searchParams.get("uselibpqcompat") === "true",
  "The approved Railway alias was not accepted with encrypted libpq-compatible SSL",
);
let unrelatedAliasRejected = false;
try {
  parseRailwayDatabaseUrl(
    "postgresql://skillplane:secret@other.db.21n.dev:47273/skillplane",
    "self-test unrelated alias",
  );
} catch {
  unrelatedAliasRejected = true;
}
assert(unrelatedAliasRejected, "An unrelated database alias was accepted");

const bannerWrappedJson = parseWranglerJson(
  `Wrangler 4.115.0\n${JSON.stringify({ id: "a".repeat(32) })}\n`,
  "self-test Wrangler response",
);
assert(
  bannerWrappedJson.id === "a".repeat(32),
  "Wrangler banner-prefixed JSON parsing failed",
);

const hyperdrive = assertHyperdriveOriginRecord(
  {
    id: "a".repeat(32),
    origin: {
      host: railway.identity.host,
      port: Number(railway.identity.port),
      database: railway.identity.database,
      user: railway.identity.username,
    },
    caching: { disabled: true },
  },
  railway.identity,
);
assert(hyperdrive.railwayOriginMatched, "Hyperdrive origin matching failed");
assert(hyperdrive.queryCacheDisabled, "Hyperdrive query caching was accepted");
let cachedHyperdriveRejected = false;
try {
  assertHyperdriveOriginRecord(
    {
      id: "a".repeat(32),
      origin: {
        host: railway.identity.host,
        port: Number(railway.identity.port),
        database: railway.identity.database,
        user: railway.identity.username,
      },
      caching: { disabled: false },
    },
    railway.identity,
  );
} catch {
  cachedHyperdriveRejected = true;
}
assert(
  cachedHyperdriveRejected,
  "A cache-enabled Hyperdrive configuration was accepted",
);
let unrelatedHyperdriveRejected = false;
try {
  assertHyperdriveOriginRecord(
    {
      id: "a".repeat(32),
      origin: {
        host: "unrelated.proxy.rlwy.net",
        port: Number(railway.identity.port),
        database: railway.identity.database,
        user: railway.identity.username,
      },
      caching: { disabled: true },
    },
    railway.identity,
  );
} catch {
  unrelatedHyperdriveRejected = true;
}
assert(
  unrelatedHyperdriveRejected,
  "A Hyperdrive configuration for another Railway origin was accepted",
);

const version = activeVersionFromDeployments([
  {
    versions: [
      {
        version_id: "00000000-0000-4000-8000-000000000000",
        percentage: 100,
      },
    ],
  },
  {
    versions: [
      {
        version_id: "12345678-1234-1234-1234-123456789abc",
        percentage: 100,
      },
    ],
  },
]);
assert(
  version === "12345678-1234-1234-1234-123456789abc",
  "Active deployment parsing failed",
);

const sanitized = sanitizeDeploymentRecord({
  token: "sensitive",
  nested: { databaseUrl: "sensitive", safe: "retained" },
});
assert(
  sanitized.token === "[redacted]" &&
    sanitized.nested.databaseUrl === "[redacted]" &&
    sanitized.nested.safe === "retained",
  "Deployment record redaction failed",
);

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    checks: {
      missingHyperdriveFailsClosed: true,
      inMemoryConfigRendering: true,
      productionRoutingModes: true,
      railwaySslForced: true,
      approvedRailwayAliasAccepted: true,
      unrelatedAliasRejected: true,
      wranglerBannerJsonParsed: true,
      hyperdriveOriginMatched: true,
      cachedHyperdriveRejected: true,
      unrelatedHyperdriveRejected: true,
      activeVersionParsing: true,
      deploymentRedaction: true,
    },
  })}\n`,
);
