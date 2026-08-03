import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, it } from "node:test";

async function readConfig(name) {
  const source = await readFile(resolve("app", name), "utf8");
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
    assert.equal(base.vars.AUTH_MODE, "disabled");
    assert.equal(authenticated.vars.AUTH_MODE, "otp");
    assert.equal(authenticated.send_email[0].name, "SEND_EMAIL");
  });
});
