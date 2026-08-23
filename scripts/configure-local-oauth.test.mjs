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

  it("rejects HTTP, credentials, app paths, and a shared origin", () => {
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
          "https://app-local.skillplane.dev/prefix",
          "https://mcp-local.skillplane.dev/mcp",
        ),
      /Local app URL must use the origin root/u,
    );
    assert.throws(
      () =>
        normalizeLocalOAuthUrls(
          "https://local.skillplane.dev",
          "https://local.skillplane.dev/mcp",
        ),
      /distinct hostnames/u,
    );
  });

  it("reports malformed, query, and fragment inputs with the correct label", () => {
    assert.throws(
      () =>
        normalizeLocalOAuthUrls("not-an-app-url", "https://mcp-local.skillplane.dev"),
      /Local app URL must be an absolute HTTPS URL/u,
    );
    assert.throws(
      () =>
        normalizeLocalOAuthUrls(
          "https://app-local.skillplane.dev?mode=local",
          "https://mcp-local.skillplane.dev",
        ),
      /Local app URL.*query/u,
    );
    assert.throws(
      () =>
        normalizeLocalOAuthUrls("https://app-local.skillplane.dev", "not-an-mcp-url"),
      /Local MCP URL must be an absolute HTTPS URL/u,
    );
    assert.throws(
      () =>
        normalizeLocalOAuthUrls(
          "https://app-local.skillplane.dev",
          "https://mcp-local.skillplane.dev#fragment",
        ),
      /Local MCP URL.*fragment/u,
    );
  });
});
