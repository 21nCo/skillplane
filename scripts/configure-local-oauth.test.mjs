import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeLocalOAuthUrls } from "./configure-local-oauth.mjs";

describe("local OAuth tunnel configuration", () => {
  it("normalizes distinct HTTPS app and MCP hostnames", () => {
    assert.deepEqual(
      normalizeLocalOAuthUrls(
        "https://app-local.skillplane.dev/",
        "https://mcp-local.skillplane.dev/ignored",
      ),
      {
        issuer: "https://app-local.skillplane.dev",
        resource: "https://mcp-local.skillplane.dev/mcp",
      },
    );
  });

  it("rejects HTTP, credentials, and a shared origin", () => {
    assert.throws(
      () =>
        normalizeLocalOAuthUrls(
          "http://app-local.skillplane.dev",
          "https://mcp-local.skillplane.dev",
        ),
      /HTTPS/u,
    );
    assert.throws(
      () =>
        normalizeLocalOAuthUrls(
          "https://user:pass@app-local.skillplane.dev",
          "https://mcp-local.skillplane.dev",
        ),
      /without credentials/u,
    );
    assert.throws(
      () =>
        normalizeLocalOAuthUrls(
          "https://local.skillplane.dev/app",
          "https://local.skillplane.dev/mcp",
        ),
      /distinct hostnames/u,
    );
  });
});
