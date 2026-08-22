import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { waitForOAuthCallback } from "./test-local-oauth.mjs";

describe("local OAuth callback timeout", () => {
  it("clears the long-lived timeout when the callback succeeds", async () => {
    await assert.doesNotReject(
      waitForOAuthCallback(Promise.resolve("authorization-code"), 60_000),
    );
  });

  it("rejects when the callback does not arrive", async () => {
    await assert.rejects(
      waitForOAuthCallback(new Promise(() => undefined), 1),
      /timed out/u,
    );
  });
});
