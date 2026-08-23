import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertPrivateDevelopmentBucket,
  developmentBucket,
  developmentIssuer,
  developmentResource,
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
