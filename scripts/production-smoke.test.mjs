import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { immutableAssetUrl } from "./production-smoke.mjs";

describe("production smoke immutable asset discovery", () => {
  it("resolves root-relative SvelteKit assets", () => {
    assert.equal(
      immutableAssetUrl(
        '<link href="/_app/immutable/assets/app.css" rel="stylesheet">',
        "https://skillplane.dev/",
      ),
      "https://skillplane.dev/_app/immutable/assets/app.css",
    );
  });

  it("resolves adapter-cloudflare relative SvelteKit assets", () => {
    assert.equal(
      immutableAssetUrl(
        '<script src="./_app/immutable/entry/start.js"></script>',
        "https://skillplane.dev/",
      ),
      "https://skillplane.dev/_app/immutable/entry/start.js",
    );
  });

  it("rejects pages without immutable assets", () => {
    assert.equal(
      immutableAssetUrl("<main>Skillplane</main>", "https://skillplane.dev/"),
      undefined,
    );
  });
});
