import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPrivateDevelopmentBucket,
  developmentCloudflareEnvironment,
  developmentDatabase,
  developmentBucket,
  developmentIssuer,
  developmentResource,
  developmentSecrets,
  developmentSiteKey,
  developmentWorkers,
  renderDevelopmentConfigs,
  requireDevelopmentHyperdriveId,
} from "./lib/development-deployment.mjs";
import {
  productionIssuer,
  productionResource,
  workers,
} from "./lib/production-deployment.mjs";
import { developmentDryRunPaths } from "./development-config-dry-run.mjs";

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

const developmentSecretEnvironment = Object.freeze({
  SKILLPLANE_DEV_AUTHFN_SECRET: "development-authfn-secret-material-1234567890",
  SKILLPLANE_DEV_OAUTH_TOKEN_PEPPER:
    "development-oauth-pepper-secret-material-1234567890",
  SKILLPLANE_DEV_TURNSTILE_SECRET_KEY:
    "development-turnstile-secret-material-1234567890",
});

describe("development deployment isolation", () => {
  it("renders two isolated development Workers without production identities", async () => {
    const id = "d".repeat(32);
    const rendered = await renderDevelopmentConfigs({
      hyperdriveId: id,
      siteKey: "development-turnstile-site-key",
      write: false,
    });

    assert.notEqual(developmentIssuer, productionIssuer);
    assert.notEqual(developmentResource, productionResource);
    assert.deepEqual(Object.keys(rendered.configs).sort(), ["app", "mcp"]);
    for (const [kind, config] of Object.entries(rendered.configs)) {
      assert.equal(config.name, developmentWorkers[kind].name);
      assert.equal(config.hyperdrive[0].id, id);
      assert.equal(config.r2_buckets[0].bucket_name, developmentBucket);
      assert.equal(config.vars.OAUTH_ISSUER, developmentIssuer);
      assert.equal(config.vars.OAUTH_RESOURCE, developmentResource);
      assert.equal(config.vars.RUNTIME_ENV, "preview");
      assert.notEqual(config.name, workers[kind].name);
    }
  });

  it("rejects missing or malformed development Hyperdrive IDs", () => {
    assert.throws(() => requireDevelopmentHyperdriveId(""), /32-character/u);
    assert.throws(() => requireDevelopmentHyperdriveId("production"), /32-character/u);
  });

  it("rejects a production Hyperdrive ID reused by development", () => {
    const id = "d".repeat(32);
    withEnvironment({ CLOUDFLARE_HYPERDRIVE_ID: id }, () =>
      assert.throws(
        () => requireDevelopmentHyperdriveId(id),
        /must differ from CLOUDFLARE_HYPERDRIVE_ID/u,
      ),
    );
  });

  it("uses explicit database identities instead of provider or database-name conventions", () => {
    const developmentUrl =
      "postgresql://skillplane:dev-secret@old.provider.example/skillplane";
    withEnvironment(
      {
        SKILLPLANE_DEV_DATABASE_URL: developmentUrl,
        SKILLPLANE_PRODUCTION_DATABASE_URL:
          "postgresql://skillplane:prod-secret@new.provider.example/skillplane",
        RAILWAY_DATABASE_URL: undefined,
      },
      () => assert.equal(developmentDatabase().identity.host, "old.provider.example"),
    );
    withEnvironment(
      {
        SKILLPLANE_DEV_DATABASE_URL: developmentUrl,
        SKILLPLANE_PRODUCTION_DATABASE_URL: developmentUrl,
        RAILWAY_DATABASE_URL: undefined,
      },
      () => assert.throws(() => developmentDatabase(), /identities must be different/u),
    );
  });

  it("requires the development bundle bucket to remain private", () => {
    assert.deepEqual(
      assertPrivateDevelopmentBucket(
        "Public access via the r2.dev URL is disabled.",
        "There are no custom domains connected to this bucket.",
      ),
      { private: true, r2DevDisabled: true, customDomainCount: 0 },
    );
    assert.throws(
      () =>
        assertPrivateDevelopmentBucket(
          "Public access via the r2.dev URL is enabled.",
          "There are no custom domains connected to this bucket.",
        ),
      /r2\.dev URL must remain disabled/u,
    );
    assert.throws(
      () =>
        assertPrivateDevelopmentBucket(
          "Public access via the r2.dev URL is disabled.",
          "dev-assets.example.test",
        ),
      /must not expose a custom domain/u,
    );
  });

  it("rejects development secrets copied from production", () => {
    withEnvironment(
      {
        ...developmentSecretEnvironment,
        AUTHFN_SECRET: developmentSecretEnvironment.SKILLPLANE_DEV_AUTHFN_SECRET,
      },
      () =>
        assert.throws(
          () => developmentSecrets(),
          /must differ from production AUTHFN_SECRET/u,
        ),
    );
  });

  it("rejects a production Turnstile widget reused by development", () => {
    withEnvironment(
      {
        PUBLIC_DEV_TURNSTILE_SITE_KEY: "development-site-key",
        PUBLIC_TURNSTILE_SITE_KEY: "development-site-key",
      },
      () =>
        assert.throws(
          () => developmentSiteKey(),
          /must differ from production PUBLIC_TURNSTILE_SITE_KEY/u,
        ),
    );
  });

  it("requires a dedicated Cloudflare API token for development deploys", () => {
    const token = "development-cloudflare-api-token-material-1234567890";
    withEnvironment(
      {
        SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_API_TOKEN: token,
      },
      () =>
        assert.throws(
          () => developmentCloudflareEnvironment(),
          /must differ from CLOUDFLARE_API_TOKEN/u,
        ),
    );
    withEnvironment(
      {
        SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: token,
        CLOUDFLARE_API_TOKEN: "production-cloudflare-api-token-material-1234567890",
        CLOUDFLARE_API_KEY: "legacy-key-must-not-be-inherited",
        CLOUDFLARE_EMAIL: "operator@example.test",
      },
      () => {
        const environment = developmentCloudflareEnvironment();
        assert.equal(environment.CLOUDFLARE_API_TOKEN, token);
        assert.equal(environment.SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN, undefined);
        assert.equal(environment.CLOUDFLARE_API_KEY, undefined);
        assert.equal(environment.CLOUDFLARE_EMAIL, undefined);
      },
    );
  });

  it("allocates collision-free config dry-run paths", () => {
    const first = developmentDryRunPaths("first-invocation");
    const second = developmentDryRunPaths();

    assert.notEqual(first.outputDirectory, second.outputDirectory);
    for (const kind of Object.keys(developmentWorkers)) {
      assert.notEqual(first.outputPaths[kind], second.outputPaths[kind]);
      assert.match(
        first.outputPaths[kind],
        new RegExp(
          `\\.data/development-config-dry-run/first-invocation/${kind}/wrangler\\.json$`,
          "u",
        ),
      );
    }
  });
});
