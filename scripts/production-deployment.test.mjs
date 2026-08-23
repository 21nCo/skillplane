import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseDirectPostgresUrl,
  postgresDockerTlsArguments,
  postgresTlsEvidence,
  productionDatabase,
  sanitizeDeploymentRecord,
} from "./lib/production-deployment.mjs";

function withEnvironment(overrides, operation) {
  const previous = new Map(
    Object.keys(overrides).map((name) => [name, process.env[name]]),
  );
  try {
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    return operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
}

describe("provider-neutral production database configuration", () => {
  it("accepts password-authenticated PostgreSQL providers with strong TLS", () => {
    const database = parseDirectPostgresUrl(
      "postgresql://skillplane:secret@db.provider.example:6543/live?sslmode=verify-full",
    );

    assert.equal(database.identity.host, "db.provider.example");
    assert.equal(database.identity.port, "6543");
    assert.equal(database.identity.database, "live");
    assert.equal(new URL(database.url).searchParams.get("sslmode"), "verify-full");
  });

  it("normalizes the libpq system trust-store hint for node-postgres", () => {
    const database = parseDirectPostgresUrl(
      "postgresql://skillplane:secret@db.provider.example/live?sslmode=verify-full&sslrootcert=system",
    );

    assert.equal(new URL(database.url).searchParams.get("sslmode"), "verify-full");
    assert.equal(new URL(database.url).searchParams.has("sslrootcert"), false);
    assert.deepEqual(postgresDockerTlsArguments(database), [
      "--env",
      "PGSSLMODE=verify-full",
      "--env",
      "PGSSLROOTCERT=/etc/ssl/certs/ca-certificates.crt",
    ]);
  });

  it("mounts an explicit CA certificate for containerized database tools", () => {
    const database = parseDirectPostgresUrl(
      "postgresql://skillplane:secret@db.provider.example/live?sslmode=verify-ca&sslrootcert=/secure/provider-ca.pem",
    );

    assert.deepEqual(postgresDockerTlsArguments(database), [
      "--env",
      "PGSSLMODE=verify-ca",
      "--volume",
      "/secure/provider-ca.pem:/skillplane-tls/root.crt:ro",
      "--env",
      "PGSSLROOTCERT=/skillplane-tls/root.crt",
    ]);
  });

  it("accepts certificate-authorized TLS when a provider proxy hides pg_stat_ssl", () => {
    const evidence = postgresTlsEvidence(
      {
        connection: {
          stream: {
            encrypted: true,
            authorized: true,
            getProtocol: () => "TLSv1.3",
            getCipher: () => ({ standardName: "TLS_AES_256_GCM_SHA384" }),
          },
        },
      },
      { ssl: false },
    );

    assert.equal(evidence.certificateAuthorized, true);
    assert.equal(evidence.serverReportedEncrypted, false);
    assert.equal(evidence.bits, 256);
  });

  it("rejects encrypted sockets without certificate or server verification", () => {
    assert.throws(
      () =>
        postgresTlsEvidence(
          { connection: { stream: { encrypted: true, authorized: false } } },
          { ssl: false },
        ),
      /not protected by verified TLS/u,
    );
  });

  it("forces encrypted defaults and rejects weak TLS modes", () => {
    const database = parseDirectPostgresUrl(
      "postgresql://skillplane:secret@db.provider.example/live",
    );
    assert.equal(new URL(database.url).searchParams.get("sslmode"), "require");
    assert.throws(
      () =>
        parseDirectPostgresUrl(
          "postgresql://skillplane:secret@db.provider.example/live?sslmode=prefer",
        ),
      /must not weaken SSL/u,
    );
  });

  it("prefers the canonical URL and rejects a conflicting legacy value", () => {
    const canonical = "postgresql://skillplane:new-secret@new.provider.example/live";
    withEnvironment(
      {
        SKILLPLANE_PRODUCTION_DATABASE_URL: canonical,
        RAILWAY_DATABASE_URL:
          "postgresql://skillplane:old-secret@old.provider.example/live",
        MIGRATION_DATABASE_URL: undefined,
      },
      () =>
        assert.throws(
          () => productionDatabase(),
          /conflicts with legacy RAILWAY_DATABASE_URL/u,
        ),
    );
    withEnvironment(
      {
        SKILLPLANE_PRODUCTION_DATABASE_URL: canonical,
        RAILWAY_DATABASE_URL: undefined,
        MIGRATION_DATABASE_URL: undefined,
      },
      () => assert.equal(productionDatabase().identity.host, "new.provider.example"),
    );
  });

  it("treats a blank canonical URL as unset", () => {
    withEnvironment(
      {
        SKILLPLANE_PRODUCTION_DATABASE_URL: "   ",
        RAILWAY_DATABASE_URL:
          "postgresql://skillplane:legacy-secret@legacy.provider.example/live",
        MIGRATION_DATABASE_URL: undefined,
      },
      () => assert.equal(productionDatabase().identity.host, "legacy.provider.example"),
    );
  });

  it("preserves non-secret status values in sanitized deployment records", () => {
    assert.deepEqual(
      sanitizeDeploymentRecord({
        runtimeDirectDatabaseUrl: false,
        databaseUrl: "postgresql://secret",
      }),
      { runtimeDirectDatabaseUrl: false, databaseUrl: "[redacted]" },
    );
  });
});
