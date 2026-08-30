import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

async function readConfig(name, directory = "app") {
  const source = await readFile(resolve(directory, name), "utf8");
  return JSON.parse(source.replace(/,\s*([}\]])/gu, "$1"));
}

describe("local app Wrangler configurations", () => {
  it("keeps runtime bindings identical while isolating OTP authority", async () => {
    const [base, authenticated] = await Promise.all([
      readConfig("wrangler.jsonc"),
      readConfig("wrangler.auth.jsonc"),
    ]);

    for (const key of [
      "name",
      "main",
      "compatibility_date",
      "compatibility_flags",
      "assets",
      "r2_buckets",
      "observability",
    ]) {
      assert.deepEqual(authenticated[key], base[key], `${key} must remain in sync`);
    }

    assert.equal(base.send_email, undefined);
    assert.equal(base.name, "skillplane-app-local");
    assert.equal(base.r2_buckets[0].bucket_name, "skillplane-skill-bundles-local");
    assert.notEqual(base.name, "skillplane-app");
    assert.notEqual(base.r2_buckets[0].bucket_name, "skillplane-skill-bundles");
    assert.equal(base.vars.AUTH_MODE, "disabled");
    assert.equal(authenticated.vars.AUTH_MODE, "otp");
    assert.equal(authenticated.send_email[0].name, "SEND_EMAIL");
    assert.deepEqual(authenticated.send_email[0].allowed_sender_addresses, [
      "no-reply@auth-dev.skillplane.dev",
    ]);
  });

  it("keeps the local MCP deploy identity away from production", async () => {
    const config = await readConfig("wrangler.jsonc", "mcp");

    assert.equal(config.name, "skillplane-mcp-local");
    assert.equal(config.r2_buckets[0].bucket_name, "skillplane-skill-bundles-local");
    assert.notEqual(config.name, "skillplane-mcp");
    assert.notEqual(config.r2_buckets[0].bucket_name, "skillplane-skill-bundles");
    assert.deepEqual(config.compatibility_flags, [
      "nodejs_compat",
      "allow_eval_during_startup",
    ]);
  });
});
