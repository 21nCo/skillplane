import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { resolve } from "node:path";
import { root } from "./lib/production-deployment.mjs";

describe("production topology manifest", () => {
  it("keeps canonical public hosts and at least two private regional cells", async () => {
    const manifest = JSON.parse(
      await readFile(resolve(root, "deployment", "topology.production.json"), "utf8"),
    );
    assert.equal(manifest.public.appAuthority, "https://app.skillplane.dev");
    assert.equal(manifest.public.mcpResource, "https://mcp.skillplane.dev/mcp");
    assert.ok(manifest.cells.length >= 2);
    assert.ok(manifest.cells.every((cell) => cell.publiclyRoutable === false));
    assert.equal(
      new Set(manifest.cells.map((cell) => cell.regionId)).size,
      manifest.cells.length,
    );
    assert.ok(
      manifest.routing.verificationKeyIds.includes(manifest.routing.activeKeyId),
    );
  });
});
