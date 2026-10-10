import { readFileSync } from "node:fs";
import { topologySecrets } from "./lib/development-topology-secrets.mjs";
import { developmentTopologyDatabases } from "./lib/development-topology-deployment.mjs";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPrivateDevelopmentBucket,
  developmentCloudflareEnvironment,
  developmentDatabase,
  developmentBucket,
  developmentIssuer,
  developmentPostHogHost,
  developmentPostHogProjectToken,
  developmentPostHogProxyHost,
  developmentResource,
  developmentSecrets,
  developmentSiteKey,
  developmentWorkers,
  productionBundleReadEnvironment,
  renderDevelopmentConfigs,
  requireDevelopmentHyperdriveId,
} from "./lib/development-deployment.mjs";
import {
  productionDatabase,
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
  PUBLIC_POSTHOG_KEY: `phc_${"d".repeat(32)}`,
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
      postHogProjectToken: developmentSecretEnvironment.PUBLIC_POSTHOG_KEY,
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
    assert.equal(
      rendered.configs.app.vars.PUBLIC_POSTHOG_KEY,
      developmentSecretEnvironment.PUBLIC_POSTHOG_KEY,
    );
    assert.equal(
      rendered.configs.app.vars.PUBLIC_POSTHOG_HOST,
      developmentPostHogProxyHost,
    );
    assert.equal(rendered.configs.mcp.vars.POSTHOG_HOST, developmentPostHogHost);
    assert.ok(developmentWorkers.mcp.secrets.includes("POSTHOG_PROJECT_TOKEN"));
  });

  it("requires a distinct development PostHog project token", () => {
    const token = `phc_${"d".repeat(32)}`;
    withEnvironment({ POSTHOG_PROJECT_TOKEN: token }, () =>
      assert.throws(
        () => developmentPostHogProjectToken(token),
        /must differ from production POSTHOG_PROJECT_TOKEN/u,
      ),
    );
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
      },
      () => assert.equal(developmentDatabase().identity.host, "old.provider.example"),
    );
    withEnvironment(
      {
        SKILLPLANE_DEV_DATABASE_URL: developmentUrl,
        SKILLPLANE_PRODUCTION_DATABASE_URL: developmentUrl,
      },
      () => assert.throws(() => developmentDatabase(), /identities must be different/u),
    );
    withEnvironment(
      {
        SKILLPLANE_DEV_DATABASE_URL: developmentUrl,
        SKILLPLANE_PRODUCTION_DATABASE_URL: undefined,
        SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL: developmentUrl,
      },
      () => assert.throws(() => developmentDatabase(), /identities must be different/u),
    );
  });

  it("keeps the retired production alias as an isolation and scrubbing sentinel", () => {
    const databases = {
      SKILLPLANE_DEV_DATABASE_URL: "postgresql://user:secret@dev.example/in_south",
      SKILLPLANE_DEV_CONTROL_DATABASE_URL:
        "postgresql://user:secret@dev.example/control",
      SKILLPLANE_DEV_USEAST_DATABASE_URL:
        "postgresql://user:secret@dev.example/us_east",
      SKILLPLANE_DEV_EUWEST_DATABASE_URL:
        "postgresql://user:secret@dev.example/eu_west",
    };
    const environment = {
      ...databases,
      SKILLPLANE_PRODUCTION_DATABASE_URL: undefined,
      SKILLPLANE_PRODUCTION_MIGRATION_SOURCE_DATABASE_URL: undefined,
      SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: "dev-cloudflare-token-material-1234567890",
      SKILLPLANE_PRODUCTION_R2_READ_TOKEN: "prod-r2-token-material-1234567890",
      SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: "b".repeat(32),
      CLOUDFLARE_ACCOUNT_ID: "c".repeat(32),
    };
    for (const url of Object.values(databases)) {
      withEnvironment({ ...environment, RAILWAY_DATABASE_URL: url }, () => {
        assert.throws(
          () => developmentTopologyDatabases(),
          /must differ|must be different/u,
        );
        assert.throws(
          () => productionDatabase(),
          /SKILLPLANE_PRODUCTION_DATABASE_URL/u,
        );
        assert.equal(
          developmentCloudflareEnvironment().RAILWAY_DATABASE_URL,
          undefined,
        );
        assert.equal(productionBundleReadEnvironment().RAILWAY_DATABASE_URL, undefined);
      });
    }
    withEnvironment(
      { ...environment, RAILWAY_DATABASE_URL: databases.SKILLPLANE_DEV_DATABASE_URL },
      () => assert.throws(() => developmentDatabase(), /identities must be different/u),
    );
    withEnvironment(
      {
        ...environment,
        RAILWAY_DATABASE_URL: "postgresql://user:secret@prod.example/prod",
      },
      () => assert.equal(Object.keys(developmentTopologyDatabases().cells).length, 3),
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
        CLOUDFLARE_ACCOUNT_ID: "C801".repeat(8),
        SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: "1bef".repeat(8),
      },
      () => {
        const environment = developmentCloudflareEnvironment();
        assert.equal(environment.CLOUDFLARE_API_TOKEN, token);
        assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, "c801".repeat(8));
        assert.equal(environment.SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN, undefined);
        assert.equal(environment.CLOUDFLARE_API_KEY, undefined);
        assert.equal(environment.CLOUDFLARE_EMAIL, undefined);
      },
    );
  });

  it("refuses development Cloudflare operations against the production account", () => {
    const token = "development-cloudflare-api-token-material-1234567890";
    const productionAccountId = "1bef".repeat(8);
    for (const [overrides, pattern] of [
      [{ CLOUDFLARE_ACCOUNT_ID: undefined }, /CLOUDFLARE_ACCOUNT_ID is required/u],
      [
        {
          CLOUDFLARE_ACCOUNT_ID: "c801".repeat(8),
          SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: undefined,
        },
        /SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID is required/u,
      ],
      [
        { CLOUDFLARE_ACCOUNT_ID: productionAccountId },
        /must be the development account/u,
      ],
      [
        { CLOUDFLARE_ACCOUNT_ID: productionAccountId.toUpperCase() },
        /must be the development account/u,
      ],
    ]) {
      withEnvironment(
        {
          SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: token,
          CLOUDFLARE_API_TOKEN: undefined,
          SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: productionAccountId,
          ...overrides,
        },
        () => assert.throws(() => developmentCloudflareEnvironment(), pattern),
      );
    }
  });

  it("uses a separate read-only token for production bundle reads", () => {
    const sourceToken = "production-r2-read-token-material-1234567890";
    const developmentToken = "development-cloudflare-token-material-1234567890";
    const sourceAccountId = "1bef".repeat(8);
    const targetAccountId = "2".repeat(32);
    withEnvironment(
      {
        SKILLPLANE_PRODUCTION_R2_READ_TOKEN: sourceToken,
        SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: sourceAccountId.toUpperCase(),
        SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: developmentToken,
        CLOUDFLARE_ACCOUNT_ID: targetAccountId,
        SKILLPLANE_PRODUCTION_DATABASE_URL:
          "postgresql://skillplane:secret@production.example/skillplane",
        CLOUDFLARE_API_KEY: "legacy-key-must-not-be-inherited",
      },
      () => {
        const environment = productionBundleReadEnvironment();
        assert.equal(environment.CLOUDFLARE_API_TOKEN, sourceToken);
        assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, sourceAccountId);
        assert.equal(
          environment.SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID,
          undefined,
        );
        assert.equal(
          developmentCloudflareEnvironment().CLOUDFLARE_ACCOUNT_ID,
          targetAccountId,
        );
        assert.equal(environment.SKILLPLANE_PRODUCTION_R2_READ_TOKEN, undefined);
        assert.equal(environment.SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN, undefined);
        assert.equal(environment.SKILLPLANE_PRODUCTION_DATABASE_URL, undefined);
        assert.equal(environment.CLOUDFLARE_API_KEY, undefined);
      },
    );
    withEnvironment(
      {
        SKILLPLANE_PRODUCTION_R2_READ_TOKEN: sourceToken,
        SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: sourceToken,
      },
      () =>
        assert.throws(
          () => productionBundleReadEnvironment(),
          /must differ from the development Cloudflare token/u,
        ),
    );
    for (const invalid of [undefined, "", "not-an-account-id"]) {
      withEnvironment(
        {
          SKILLPLANE_PRODUCTION_R2_READ_TOKEN: sourceToken,
          SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN: developmentToken,
          SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID: invalid,
          CLOUDFLARE_ACCOUNT_ID: targetAccountId,
        },
        () =>
          assert.throws(
            () => productionBundleReadEnvironment(),
            /SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID/u,
          ),
      );
    }
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

it("provisions the development token for all MCP outputs without leaking it to other cells", () => {
  withEnvironment(
    {
      ...developmentSecretEnvironment,
      POSTHOG_PROJECT_TOKEN: `phc_${"p".repeat(32)}`,
      SKILLPLANE_DEV_WORKSPACE_ROUTING_SECRET:
        "test-only-development-routing-material-000000",
    },
    () => {
      const topology = JSON.parse(
        readFileSync(
          new URL("../deployment/topology.development.json", import.meta.url),
          "utf8",
        ),
      );
      for (const id of [
        "gateway:mcp",
        ...topology.cells.map((cell) => `${cell.regionId}:mcp`),
      ]) {
        assert.equal(
          topologySecrets({ id, kind: "mcp" }).POSTHOG_PROJECT_TOKEN,
          developmentSecretEnvironment.PUBLIC_POSTHOG_KEY,
        );
      }
      assert.equal(
        topologySecrets({ id: "in-south:app", kind: "app" }).POSTHOG_PROJECT_TOKEN,
        undefined,
      );
      assert.equal(topologySecrets({ kind: "projection" }), null);
    },
  );
});
