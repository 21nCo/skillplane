import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  developmentBucket,
  developmentIssuer,
  developmentResource,
  developmentWorkers,
  renderDevelopmentConfigs,
  requireDevelopmentHyperdriveId,
} from "./lib/development-deployment.mjs";

describe("development deployment isolation", () => {
  it("renders two isolated development Workers without production identities", async () => {
    const id = "d".repeat(32);
    const rendered = await renderDevelopmentConfigs({
      hyperdriveId: id,
      siteKey: "development-turnstile-site-key",
      write: false,
    });

    assert.deepEqual(Object.keys(rendered.configs).sort(), ["app", "mcp"]);
    for (const [kind, config] of Object.entries(rendered.configs)) {
      assert.equal(config.name, developmentWorkers[kind].name);
      assert.equal(config.hyperdrive[0].id, id);
      assert.equal(config.r2_buckets[0].bucket_name, developmentBucket);
      assert.equal(config.vars.OAUTH_ISSUER, developmentIssuer);
      assert.equal(config.vars.OAUTH_RESOURCE, developmentResource);
      assert.equal(config.vars.RUNTIME_ENV, "preview");
      assert.notEqual(config.name, `skillplane-${kind}`);
    }
  });

  it("rejects missing or malformed development Hyperdrive IDs", () => {
    assert.throws(() => requireDevelopmentHyperdriveId(""), /32-character/u);
    assert.throws(() => requireDevelopmentHyperdriveId("production"), /32-character/u);
  });
});
