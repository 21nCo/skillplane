import assert from "node:assert/strict";
import { after, before, it } from "node:test";
import { sendChallenge } from "./verify-email-production.mjs";

const previousToken = process.env.SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN;
before(() => {
  process.env.SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN = "test-turnstile-evidence-only";
});
after(() => {
  if (previousToken === undefined) {
    delete process.env.SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN;
  } else {
    process.env.SKILLPLANE_PRODUCTION_TURNSTILE_TOKEN = previousToken;
  }
});

it("uses native OTP metadata and records native delivery acceptance", async () => {
  let persisted;
  const result = await sendChallenge("person@example.test", {
    fetcher: async (url, options) => {
      assert.ok(url.endsWith("/auth/otp/send"));
      assert.deepEqual(JSON.parse(options.body), {
        email: "person@example.test",
        purpose: "sign-up",
        metadata: { turnstileToken: "test-turnstile-evidence-only" },
      });
      return Response.json(
        {
          ok: true,
          data: { challengeId: "challenge_test", sent: true },
          requestId: "req_test",
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    },
    persistState: async (state) => {
      persisted = state;
    },
  });
  assert.equal(result.status, "awaiting-otp");
  assert.equal(persisted.deliveryAccepted, true);
  assert.equal(persisted.requestId, "req_test");
  assert.doesNotMatch(JSON.stringify(persisted), /person@example|test-turnstile/);
});

it("does not record unsuccessful or malformed native delivery results", async () => {
  for (const data of [
    { challengeId: "challenge_test", sent: false },
    { challengeId: "", sent: true },
    { accepted: true, expiresInSeconds: 600 },
  ]) {
    await assert.rejects(
      sendChallenge("person@example.test", {
        fetcher: async () =>
          Response.json(
            { ok: true, data },
            { headers: { "cache-control": "private, no-store" } },
          ),
        persistState: async () => assert.fail("Must not record failed delivery"),
      }),
      /did not accept/,
    );
  }
});
