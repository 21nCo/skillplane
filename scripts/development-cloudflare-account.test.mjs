import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { verifiedDevelopmentCloudflareEnvironment } from "./lib/development-deployment.mjs";
import {
  accountListing,
  developmentAccountId,
  developmentToken,
  otherAccountId,
  productionAccountId,
  releaseAccountId,
  withDevelopmentCloudflare,
} from "./lib/cloudflare-accounts-fixture.mjs";
import { deployDevelopment } from "./deploy-development.mjs";
import { deployDevelopmentTopology } from "./deploy-development-topology.mjs";
import { migrateDevelopment } from "./migrate-development.mjs";
import { migrateDevelopmentTopology } from "./migrate-development-topology.mjs";
import { prepareDevelopmentTopologyDatabases } from "./prepare-development-topology-databases.mjs";
import { reconcileDevelopmentBundles } from "./reconcile-development-bundles.mjs";
import { smokeDevelopment } from "./smoke-development.mjs";
import { testDevelopmentOAuth } from "./test-development-oauth.mjs";

const scopeRefusal =
  /^DEV_CLOUDFLARE_TOKEN_SCOPE: SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN /u;
const listingRefusal =
  /^DEV_CLOUDFLARE_TOKEN_SCOPE: could not list the Cloudflare accounts SKILLPLANE_DEV_CLOUDFLARE_API_TOKEN can access \(/u;

function preflight(fetch, environment = {}) {
  return withDevelopmentCloudflare({ fetch, environment }, () =>
    verifiedDevelopmentCloudflareEnvironment(),
  );
}

async function refusal(fetch, environment) {
  let caught;
  await preflight(fetch, environment).catch((error) => {
    caught = error;
  });
  assert.ok(caught instanceof Error, "the preflight must refuse");
  assert.ok(!caught.message.includes(developmentToken), caught.message);
  assert.ok(!String(caught.stack).includes(developmentToken));
  return caught.message;
}

function failingFetch(response) {
  return async () => (typeof response === "function" ? response() : response);
}

describe("development Cloudflare token account preflight", () => {
  it("passes a token that can access only the development account", async () => {
    const calls = [];
    const environment = await preflight(accountListing([developmentAccountId], calls), {
      // A different ambient production token is never the one sent.
      CLOUDFLARE_API_TOKEN: "production-cloudflare-api-token-material-1234567890",
      SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID: releaseAccountId,
    });
    assert.equal(environment.CLOUDFLARE_API_TOKEN, developmentToken);
    assert.equal(environment.CLOUDFLARE_ACCOUNT_ID, developmentAccountId);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0].url,
      "https://api.cloudflare.com/client/v4/accounts?page=1&per_page=50",
    );
    assert.equal(calls[0].authorization, `Bearer ${developmentToken}`);
  });

  it("accepts the pinned account in any letter case", async () => {
    await preflight(accountListing([developmentAccountId.toUpperCase()]), {
      CLOUDFLARE_ACCOUNT_ID: developmentAccountId.toUpperCase(),
    });
  });

  for (const [label, pages, environment, expected] of [
    [
      "a production-only token",
      [productionAccountId],
      {},
      `can access the production account ${productionAccountId} (SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID)`,
    ],
    [
      "a development and production token",
      [developmentAccountId, productionAccountId],
      {},
      `can access the production account ${productionAccountId} (SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID)`,
    ],
    [
      "a token that can access the production release account",
      [developmentAccountId, releaseAccountId],
      { SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID: releaseAccountId },
      `can access the production account ${releaseAccountId} (SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID)`,
    ],
    [
      "a production account listed on a later page",
      [[developmentAccountId], [productionAccountId]],
      {},
      `can access the production account ${productionAccountId} (SKILLPLANE_PRODUCTION_CLOUDFLARE_ACCOUNT_ID)`,
    ],
    [
      "a development and other-account token",
      [developmentAccountId, otherAccountId],
      {},
      `can access an account other than the development account: ${otherAccountId}`,
    ],
    [
      "a token for one unrelated account",
      [otherAccountId],
      {},
      `can access an account other than the development account: ${otherAccountId}`,
    ],
    [
      "a token that can access no account",
      [],
      {},
      "cannot access the development account",
    ],
  ]) {
    it(`refuses ${label}`, async () => {
      const message = await refusal(accountListing(pages), environment);
      assert.match(message, scopeRefusal);
      assert.ok(message.includes(expected), message);
      assert.ok(
        message.includes(
          `must access only the development account ${developmentAccountId} (CLOUDFLARE_ACCOUNT_ID)`,
        ),
        message,
      );
      const listed = pages.flat();
      assert.ok(
        message.endsWith(
          `Accessible accounts: ${listed.length > 0 ? listed.join(", ") : "none"}`,
        ),
        message,
      );
    });
  }

  it("refuses CLOUDFLARE_ACCOUNT_ID set to the release account before listing", async () => {
    const calls = [];
    await assert.rejects(
      preflight(accountListing([releaseAccountId], calls), {
        CLOUDFLARE_ACCOUNT_ID: releaseAccountId,
        SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID: releaseAccountId.toUpperCase(),
      }),
      /^Error: CLOUDFLARE_ACCOUNT_ID must be the development account, not SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID$/u,
    );
    await assert.rejects(
      preflight(accountListing([developmentAccountId], calls), {
        SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID: "not-an-account-id",
      }),
      /SKILLPLANE_RELEASE_CLOUDFLARE_ACCOUNT_ID has an invalid format/u,
    );
    assert.equal(calls.length, 0);
  });

  const json = (body, status = 200) => Response.json(body, { status });
  const fullPage = Array.from({ length: 50 }, () => ({ id: developmentAccountId }));
  for (const [label, fetch, reason] of [
    ["an HTTP error", failingFetch(json({ success: false }, 403)), "HTTP 403"],
    [
      "a network error",
      async () => {
        throw new TypeError("fetch failed", {
          cause: Object.assign(new Error("getaddrinfo"), { code: "ENOTFOUND" }),
        });
      },
      "request failed: ENOTFOUND",
    ],
    [
      "a rejected header that echoes the token",
      async () => {
        throw new TypeError(`Headers.append: "Bearer ${developmentToken}" is invalid`);
      },
      "request failed",
    ],
    [
      "a timeout",
      async () => {
        throw new DOMException("The operation was aborted", "TimeoutError");
      },
      "timed out",
    ],
    [
      "a non-JSON response",
      failingFetch(new Response("<html>", { status: 200 })),
      "the response was not JSON",
    ],
    [
      "an unsuccessful response",
      failingFetch(json({ success: false, result: [] })),
      "the response was not a successful account list",
    ],
    [
      "an invalid account ID",
      failingFetch(json({ success: true, result: [{ id: "not-an-account" }] })),
      "the response contained an invalid account ID",
    ],
    [
      "a full page without pagination",
      failingFetch(json({ success: true, result: fullPage })),
      "a full page omitted its pagination",
    ],
    [
      "invalid pagination",
      failingFetch(
        json({
          success: true,
          result: [{ id: developmentAccountId }],
          result_info: { total_pages: "1" },
        }),
      ),
      "the response had invalid pagination",
    ],
    [
      "unbounded pagination",
      failingFetch(() =>
        json({
          success: true,
          result: [{ id: developmentAccountId }],
          result_info: { total_pages: 1000 },
        }),
      ),
      "more than 20 pages of accounts",
    ],
  ]) {
    it(`fails the run on ${label}`, async () => {
      const message = await refusal(fetch);
      assert.match(message, listingRefusal);
      assert.ok(message.includes(`(${reason})`), message);
      assert.ok(
        message.includes(
          `the development account ${developmentAccountId} (CLOUDFLARE_ACCOUNT_ID)`,
        ),
        message,
      );
    });
  }
});

// The environment of each entrypoint holds only the Cloudflare variables, so
// a render, Wrangler, database parse or connection, or smoke request that ran
// before the preflight would fail with a different error, make a request the
// stub refuses, or count as an injected step.
describe("development entrypoints verify the Cloudflare token first", () => {
  const productionOnly =
    /^Error: DEV_CLOUDFLARE_TOKEN_SCOPE: .*can access the production account/u;
  const counted = () => {
    const counter = { count: 0 };
    counter.step = async () => {
      counter.count += 1;
    };
    return counter;
  };

  for (const [name, invoke] of [
    ["deploy:dev", () => deployDevelopment()],
    ["deploy:dev:topology", () => deployDevelopmentTopology({ onlyKinds: ["app"] })],
    [
      "db:migrate:dev",
      (step) =>
        migrateDevelopment({
          database: { url: "postgresql://dev:secret@dev.invalid/skillplane" },
          run: step,
        }),
    ],
    [
      "db:migrate:dev:topology",
      (step) => migrateDevelopmentTopology({ migrate: step }),
    ],
    [
      "db:prepare:dev:topology",
      () =>
        prepareDevelopmentTopologyDatabases({
          confirmControlDatabase: "skillplane_control",
          confirmRegionalizeDatabase: "skillplane",
        }),
    ],
    ["smoke:dev", () => smokeDevelopment()],
    ["test:dev:oauth", (step) => testDevelopmentOAuth({ verify: step })],
    [
      "r2:sync:dev",
      (step) =>
        reconcileDevelopmentBundles({ getSourceObject: step, putTargetObject: step }),
    ],
  ]) {
    it(`${name} refuses a production-account token before any other step`, async () => {
      const calls = [];
      const steps = counted();
      await withDevelopmentCloudflare(
        { fetch: accountListing([developmentAccountId, productionAccountId], calls) },
        () => assert.rejects(invoke(steps.step), productionOnly),
      );
      assert.equal(steps.count, 0);
      assert.deepEqual(
        calls.map((call) => call.authorization),
        [`Bearer ${developmentToken}`],
      );
    });
  }

  it("db:migrate:dev continues with a development-only token", async () => {
    const steps = counted();
    const result = await withDevelopmentCloudflare(
      { fetch: accountListing([developmentAccountId]) },
      () =>
        migrateDevelopment({
          database: {
            url: "postgresql://dev:secret@dev.invalid/skillplane",
            fingerprint: "development",
          },
          run: steps.step,
        }),
    );
    assert.equal(result.ok, true);
    assert.equal(steps.count, 2);
  });

  it("smoke:dev reaches the development app only after the preflight passes", async () => {
    const requested = [];
    const listing = accountListing([developmentAccountId]);
    await withDevelopmentCloudflare(
      {
        fetch: async (url, init) => {
          if (String(url).startsWith("https://api.cloudflare.com/")) {
            requested.push("accounts");
            return listing(url, init);
          }
          requested.push(new URL(String(url)).host);
          throw new Error("smoke request stopped by the test");
        },
      },
      () => assert.rejects(smokeDevelopment(), /smoke request stopped by the test/u),
    );
    assert.deepEqual(requested, ["accounts", "skillplane-app.21n.dev"]);
  });
});
