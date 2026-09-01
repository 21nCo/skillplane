import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { routingKeys } from "./deploy-topology.mjs";

const previous = {
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
const authSecret = "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6";
const oauthSecret = "Q1w2E3r4T5y6U7i8O9p0A1s2D3f4G5h6";
const routingSecret = "Z1x2C3v4B5n6M7a8S9d0F1g2H3j4K5l6";

describe("production routing key safety", () => {
  it("rejects duplicate key values", () => {
    process.env.AUTHFN_SECRET = authSecret;
    process.env.OAUTH_TOKEN_PEPPER = oauthSecret;
    process.env.WORKSPACE_ROUTING_KEYS = JSON.stringify({
      current: routingSecret,
      previous: routingSecret,
    });
    assert.throws(() => routingKeys(manifest), /does not match the topology keyring/u);
  });

  it("rejects a routing key reused as an identity secret", () => {
    process.env.AUTHFN_SECRET = authSecret;
    process.env.OAUTH_TOKEN_PEPPER = oauthSecret;
    process.env.WORKSPACE_ROUTING_KEYS = JSON.stringify({
      current: process.env.AUTHFN_SECRET,
      previous: routingSecret,
    });
    assert.throws(() => routingKeys(manifest), /independent identity secrets/u);
  });
});
