import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

describe("local and development command entrypoints", () => {
  it("can be imported when Node has no script argv", () => {
    const modules = [
      "scripts/configure-local-oauth.mjs",
      "scripts/deploy-development.mjs",
      "scripts/development-config-dry-run.mjs",
      "scripts/local-init.mjs",
      "scripts/migrate-development.mjs",
      "scripts/render-development-config.mjs",
      "scripts/smoke-development.mjs",
      "scripts/test-development-oauth.mjs",
      "scripts/test-local-oauth.mjs",
    ].map((path) => pathToFileURL(resolve(root, path)).href);
    const source = `process.argv.splice(1); await Promise.all(${JSON.stringify(
      modules,
    )}.map((moduleUrl) => import(moduleUrl)));`;
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { cwd: root, encoding: "utf8" },
    );

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
  });
});
