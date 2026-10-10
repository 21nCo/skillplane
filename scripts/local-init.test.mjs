import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectSharedOAuthPepper, selectTurnstileCredentials } from "./local-init.mjs";

describe("local environment initialization", () => {
  it("preserves one shared OAuth pepper across both Workers", () => {
    const generated = [];
    const retained = [];
    const value = "stable-local-oauth-pepper-with-32-characters";
    assert.equal(selectSharedOAuthPepper(value, value, generated, retained), value);
    assert.deepEqual(generated, []);
    assert.deepEqual(retained, ["OAUTH_TOKEN_PEPPER"]);
  });

  it("rejects divergent OAuth peppers instead of invalidating credentials", () => {
    assert.throws(
      () =>
        selectSharedOAuthPepper(
          "first-local-oauth-pepper-with-32-characters",
          "second-local-oauth-pepper-with-32-characters",
          [],
          [],
        ),
      /differs between app\/\.dev\.vars and mcp\/\.dev\.vars/u,
    );
  });

  it("initializes the official paired local Turnstile test credentials", () => {
    const generated = [];
    assert.deepEqual(selectTurnstileCredentials(undefined, undefined, generated, []), {
      siteKey: "1x00000000000000000000AA",
      secretKey: "1x0000000000000000000000000000000AA",
    });
    assert.deepEqual(generated, ["PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]);
  });

  it("retains the exact official Turnstile test pair on repeated initialization", () => {
    const retained = [];
    assert.deepEqual(
      selectTurnstileCredentials(
        "1x00000000000000000000AA",
        "1x0000000000000000000000000000000AA",
        [],
        retained,
      ),
      {
        siteKey: "1x00000000000000000000AA",
        secretKey: "1x0000000000000000000000000000000AA",
      },
    );
    assert.deepEqual(retained, ["PUBLIC_TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"]);
  });

  it("rejects a partial Turnstile credential pair", () => {
    assert.throws(
      () => selectTurnstileCredentials("1x00000000000000000000AA", undefined, [], []),
      /must be configured together/u,
    );
  });
});
