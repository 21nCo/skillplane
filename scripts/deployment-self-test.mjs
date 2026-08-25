#!/usr/bin/env node

import {
  activeVersionFromDeployments,
  parseDirectPostgresUrl,
  requireHyperdriveId,
  requirePostHogProjectToken,
  sanitizeDeploymentRecord,
  workers,
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

let invalidPostHogTokenRejected = false;
try {
  requirePostHogProjectToken("placeholder");
} catch {
  invalidPostHogTokenRejected = true;
}
assert(invalidPostHogTokenRejected, "An invalid PostHog project token was accepted");

const rendered = await renderDeploymentConfigs({
  hyperdriveId: "a".repeat(32),
  siteKey: "turnstile-self-test-site-key",
  postHogProjectToken: `phc_${"a".repeat(32)}`,
  write: false,
});
assert(Object.keys(rendered.configs).length === 2, "Two configs were not rendered");
assert(
  rendered.configs.app.routing.type === "custom-domain" &&
    rendered.configs.mcp.routing.type === "custom-domain",
  "Production routing modes were not rendered correctly",
);
assert(
  workers.mcp.secretNames.includes("POSTHOG_PROJECT_TOKEN"),
  "The MCP production secret inventory omitted PostHog",
);

const postgres = parseDirectPostgresUrl(
  "postgresql://skillplane:secret@db.example.test:12345/skillplane",
  "self-test PostgreSQL URL",
);
assert(
  new URL(postgres.url).searchParams.get("sslmode") === "require",
  "PostgreSQL SSL was not forced",
);
assert(
  !JSON.stringify({
    fingerprint: postgres.fingerprint,
    identity: postgres.identity,
  }).includes("secret"),
  "The sanitized PostgreSQL identity retained a password",
);

const compatibleAlias = parseDirectPostgresUrl(
  "postgresql://skillplane:secret@insouth.db.21n.dev:47273/skillplane",
  "self-test libpq-compatible alias",
);
assert(
  compatibleAlias.identity.host === "insouth.db.21n.dev" &&
    new URL(compatibleAlias.url).searchParams.get("sslmode") === "require" &&
    new URL(compatibleAlias.url).searchParams.get("uselibpqcompat") === "true",
  "The controlled alias was not accepted with encrypted libpq-compatible SSL",
);
let weakSslRejected = false;
try {
  parseDirectPostgresUrl(
    "postgresql://skillplane:secret@db.example.test:5432/skillplane?sslmode=prefer",
    "self-test weak SSL URL",
  );
} catch {
  weakSslRejected = true;
}
assert(weakSslRejected, "A PostgreSQL URL with weak SSL was accepted");

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
      host: postgres.identity.host,
      port: Number(postgres.identity.port),
      database: postgres.identity.database,
      user: "dedicated_hyperdrive_runtime",
    },
    caching: { disabled: true },
  },
  postgres.identity,
);
assert(hyperdrive.databaseOriginMatched, "Hyperdrive origin matching failed");
assert(hyperdrive.queryCacheDisabled, "Hyperdrive query caching was accepted");
let cachedHyperdriveRejected = false;
try {
  assertHyperdriveOriginRecord(
    {
      id: "a".repeat(32),
      origin: {
        host: postgres.identity.host,
        port: Number(postgres.identity.port),
        database: postgres.identity.database,
        user: postgres.identity.username,
      },
      caching: { disabled: false },
    },
    postgres.identity,
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
        port: Number(postgres.identity.port),
        database: postgres.identity.database,
        user: postgres.identity.username,
      },
      caching: { disabled: true },
    },
    postgres.identity,
  );
} catch {
  unrelatedHyperdriveRejected = true;
}
assert(
  unrelatedHyperdriveRejected,
  "A Hyperdrive configuration for another PostgreSQL origin was accepted",
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
      invalidPostHogTokenRejected: true,
      missingHyperdriveFailsClosed: true,
      inMemoryConfigRendering: true,
      productionRoutingModes: true,
      postgresSslForced: true,
      controlledAliasAccepted: true,
      weakSslRejected: true,
      wranglerBannerJsonParsed: true,
      hyperdriveOriginMatched: true,
      cachedHyperdriveRejected: true,
      unrelatedHyperdriveRejected: true,
      activeVersionParsing: true,
      deploymentRedaction: true,
    },
  })}\n`,
);
