import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { routingKeys, secretsFor } from "./deploy-topology.mjs";

const previous = {
  POSTHOG_PROJECT_TOKEN: process.env.POSTHOG_PROJECT_TOKEN,
  AUTHFN_SECRET: process.env.AUTHFN_SECRET,
  OAUTH_TOKEN_PEPPER: process.env.OAUTH_TOKEN_PEPPER,
  WORKSPACE_ROUTING_KEYS: process.env.WORKSPACE_ROUTING_KEYS,
};

afterEach(() => {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) Reflect.deleteProperty(process.env, name);
    else process.env[name] = value;
  }
});

const manifest = {
  routing: { activeKeyId: "current", verificationKeyIds: ["current", "previous"] },
};
const authSecret = "test-only-authfn-secret-not-a-credential";
const oauthSecret = "test-only-oauth-pepper-not-a-credential";
const currentRoutingSecret = "test-only-current-routing-key-not-a-secret";
const previousRoutingSecret = "test-only-previous-routing-key-not-a-secret";

describe("production routing key safety", () => {
  it("accepts distinct routing keys independent from identity secrets", () => {
    process.env.AUTHFN_SECRET = authSecret;
    process.env.OAUTH_TOKEN_PEPPER = oauthSecret;
    process.env.WORKSPACE_ROUTING_KEYS = JSON.stringify({
      current: currentRoutingSecret,
      previous: previousRoutingSecret,
    });

    assert.equal(routingKeys(manifest), process.env.WORKSPACE_ROUTING_KEYS);
  });

  it("rejects duplicate key values", () => {
    process.env.AUTHFN_SECRET = authSecret;
    process.env.OAUTH_TOKEN_PEPPER = oauthSecret;
    process.env.WORKSPACE_ROUTING_KEYS = JSON.stringify({
      current: currentRoutingSecret,
      previous: currentRoutingSecret,
    });
    assert.throws(() => routingKeys(manifest), /does not match the topology keyring/u);
  });

  it("rejects a routing key reused as an identity secret", () => {
    process.env.AUTHFN_SECRET = authSecret;
    process.env.OAUTH_TOKEN_PEPPER = oauthSecret;
    process.env.WORKSPACE_ROUTING_KEYS = JSON.stringify({
      current: process.env.AUTHFN_SECRET,
      previous: previousRoutingSecret,
    });
    assert.throws(() => routingKeys(manifest), /independent identity secrets/u);
  });
});

it("provisions PostHog on the gateway and every regional MCP worker", () => {
  process.env.AUTHFN_SECRET = authSecret;
  process.env.OAUTH_TOKEN_PEPPER = oauthSecret;
  process.env.WORKSPACE_ROUTING_KEYS = JSON.stringify({
    current: currentRoutingSecret,
    previous: previousRoutingSecret,
  });
  process.env.POSTHOG_PROJECT_TOKEN = `phc_${"t".repeat(32)}`;
  for (const id of ["gateway:mcp", "in-south:mcp", "us-east:mcp"]) {
    assert.equal(
      secretsFor({ id, kind: "mcp" }, manifest).POSTHOG_PROJECT_TOKEN,
      process.env.POSTHOG_PROJECT_TOKEN,
    );
  }
  assert.equal(
    secretsFor({ id: "in-south:app", kind: "app" }, manifest).POSTHOG_PROJECT_TOKEN,
    undefined,
  );
  assert.equal(secretsFor({ kind: "projection" }, manifest), null);
});
