import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  listCloudflareReleaseLedger,
  recordCloudflareRelease,
} from "./lib/github-release-ledger.mjs";
import {
  activeCloudflareVersionId,
  assertCloudflareReleaseOrder,
  assertCloudflareProductionOrder,
  compareCloudflareReleaseTags,
  packagePublishDecision,
  resolveCloudflareRelease,
  resolvePackageRelease,
  writeGithubOutputs,
} from "./lib/release-tags.mjs";

/** Create a disposable release manifest and package fixture. */
async function fixture(packageJson = {}) {
  const root = await mkdtemp(join(tmpdir(), "skillplane-release-tags-"));
  await mkdir(join(root, "packages", "cli"), { recursive: true });
  await writeFile(
    join(root, "release-packages.json"),
    `${JSON.stringify([
      { slug: "skillplane", path: "packages/cli", name: "skillplane" },
    ])}\n`,
  );
  await writeFile(
    join(root, "packages", "cli", "package.json"),
    `${JSON.stringify({ name: "skillplane", version: "1.2.3", ...packageJson })}\n`,
  );
  return root;
}

describe("tagged releases", () => {
  it("resolves a package tag only when its version matches", async () => {
    const root = await fixture();
    try {
      assert.deepEqual(await resolvePackageRelease("skillplane-v1.2.3", root), {
        tag: "skillplane-v1.2.3",
        slug: "skillplane",
        name: "skillplane",
        version: "1.2.3",
        path: "packages/cli",
        npmTag: "latest",
      });
      await assert.rejects(
        resolvePackageRelease("skillplane-v1.2.4", root),
        /does not match/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("routes prerelease packages away from npm latest", async () => {
    const root = await fixture({ version: "1.2.3-rc.1" });
    try {
      assert.equal(
        (await resolvePackageRelease("skillplane-v1.2.3-rc.1", root)).npmTag,
        "next",
      );
      await assert.rejects(
        resolvePackageRelease("skillplane-v1.2.3-01", root),
        /Unsupported tag format/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps stable build metadata on npm latest", async () => {
    const root = await fixture({ version: "1.2.3+build-alpha" });
    try {
      assert.equal(
        (await resolvePackageRelease("skillplane-v1.2.3+build-alpha", root)).npmTag,
        "latest",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects private publish targets", async () => {
    const root = await fixture({ private: true });
    try {
      await assert.rejects(
        resolvePackageRelease("skillplane-v1.2.3", root),
        /is private/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("accepts only the dedicated Cloudflare tag namespace", () => {
    assert.deepEqual(resolveCloudflareRelease("skillplane-cloudflare-v2.0.0-rc.1"), {
      tag: "skillplane-cloudflare-v2.0.0-rc.1",
      version: "2.0.0-rc.1",
    });
    assert.throws(
      () => resolveCloudflareRelease("skillplane-v2.0.0"),
      /Unsupported Cloudflare tag/u,
    );
    assert.throws(
      () => resolveCloudflareRelease("skillplane-cloudflare-v2.0.0+build.1"),
      /Unsupported Cloudflare tag/u,
    );
    for (const tag of [
      "skillplane-cloudflare-v02.0.0",
      "skillplane-cloudflare-v2.0.0-01",
      "skillplane-cloudflare-v2.0.0-alpha..1",
    ]) {
      assert.throws(() => resolveCloudflareRelease(tag), /Unsupported Cloudflare tag/u);
    }
    assert.throws(
      () => resolveCloudflareRelease(`skillplane-cloudflare-v2.0.0-${"a".repeat(40)}`),
      /must not exceed 54 characters/u,
    );
  });

  it("orders Cloudflare release tags using SemVer precedence", () => {
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0-rc.10",
        "skillplane-cloudflare-v2.0.0-rc.2",
      ),
      1,
    );
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0",
        "skillplane-cloudflare-v2.0.0-rc.10",
      ),
      1,
    );
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0-alpha-beta.2",
        "skillplane-cloudflare-v2.0.0-alpha-beta.1",
      ),
      1,
    );
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0-alpha.1",
        "skillplane-cloudflare-v2.0.0-1",
      ),
      1,
    );
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0-rc.1",
        "skillplane-cloudflare-v2.0.0-rc",
      ),
      1,
    );
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0-rc.1",
        "skillplane-cloudflare-v2.0.0",
      ),
      -1,
    );
    assert.equal(
      compareCloudflareReleaseTags(
        "skillplane-cloudflare-v2.0.0",
        "skillplane-cloudflare-v2.0.0",
      ),
      0,
    );
  });

  it("rejects production release downgrades but permits retries", () => {
    assert.deepEqual(
      assertCloudflareReleaseOrder(
        "skillplane-cloudflare-v2.1.0",
        "skillplane-cloudflare-v2.1.0",
      ),
      {
        deployedTag: "skillplane-cloudflare-v2.1.0",
        requestedTag: "skillplane-cloudflare-v2.1.0",
      },
    );
    assert.throws(
      () =>
        assertCloudflareReleaseOrder(
          "skillplane-cloudflare-v2.1.0",
          "skillplane-cloudflare-v2.0.9",
        ),
      /use the production rollback procedure/u,
    );
  });

  it("uses the durable ledger when a newer release stops after migration", () => {
    assert.throws(
      () =>
        assertCloudflareProductionOrder({
          requestedTag: "skillplane-cloudflare-v2.0.0",
          deployedTag: "skillplane-cloudflare-v2.0.0",
          ledgerTags: ["skillplane-cloudflare-v2.1.0"],
        }),
      /older than deployed release/u,
    );
    assert.deepEqual(
      assertCloudflareProductionOrder({
        requestedTag: "skillplane-cloudflare-v2.1.0",
        deployedTag: "skillplane-cloudflare-v2.0.0",
        ledgerTags: ["skillplane-cloudflare-v2.0.0", "skillplane-cloudflare-v2.1.0"],
      }),
      {
        deployedTag: "skillplane-cloudflare-v2.0.0",
        ledgerTag: "skillplane-cloudflare-v2.1.0",
        requestedTag: "skillplane-cloudflare-v2.1.0",
      },
    );
  });

  it("requires a protected override for an unrecognized active deployment", () => {
    const input = {
      requestedTag: "skillplane-cloudflare-v2.0.0",
      deployedTag: "phase16-legacy-release",
      ledgerTags: [],
    };
    assert.throws(
      () => assertCloudflareProductionOrder(input),
      /protected legacy bootstrap override/u,
    );
    assert.deepEqual(
      assertCloudflareProductionOrder({ ...input, allowLegacyBootstrap: true }),
      {
        deployedTag: "phase16-legacy-release",
        ledgerTag: null,
        requestedTag: "skillplane-cloudflare-v2.0.0",
      },
    );
  });

  it("fails closed when Wrangler cannot identify one active version", () => {
    assert.equal(activeCloudflareVersionId([]), null);
    assert.equal(
      activeCloudflareVersionId([
        { versions: [{ version_id: "version-one", percentage: 100 }] },
      ]),
      "version-one",
    );
    assert.throws(
      () => activeCloudflareVersionId([{ versions: [] }]),
      /omitted its versions/u,
    );
    assert.throws(
      () =>
        activeCloudflareVersionId([
          { versions: [{ version_id: "older-version", percentage: 100 }] },
          { versions: [] },
        ]),
      /omitted its versions/u,
    );
    assert.throws(
      () =>
        activeCloudflareVersionId([
          {
            versions: [
              { version_id: "version-one", percentage: 50 },
              { version_id: "version-two", percentage: 50 },
            ],
          },
        ]),
      /split traffic/u,
    );
  });

  it("advances npm channels monotonically and makes exact retries idempotent", () => {
    assert.deepEqual(packagePublishDecision(undefined, "1.0.0"), {
      publish: true,
      publishedVersion: undefined,
      requestedVersion: "1.0.0",
    });
    assert.equal(packagePublishDecision("1.0.0", "1.0.0").publish, false);
    assert.equal(packagePublishDecision("1.0.0", "1.1.0").publish, true);
    assert.throws(
      () => packagePublishDecision("1.1.0", "1.0.0"),
      /older than published channel version/u,
    );
    assert.throws(
      () => packagePublishDecision("1.0.0+one", "1.0.0+two"),
      /does not advance/u,
    );
  });

  it("reads and records the GitHub deployment ledger", async () => {
    const environment = {
      GITHUB_REPOSITORY: "21nCo/skillplane",
      GH_TOKEN: "test-token",
    };
    const requests = [];
    const transport = async (url, options = {}) => {
      requests.push({ url: String(url), options });
      if (options.method === "POST") {
        return new Response(JSON.stringify({ id: 42 }), { status: 201 });
      }
      return new Response(
        JSON.stringify([
          {
            environment: "skillplane-cloudflare-release-ledger",
            ref: "skillplane-cloudflare-v2.1.0",
          },
        ]),
        { status: 200 },
      );
    };
    assert.deepEqual(await listCloudflareReleaseLedger(environment, transport), [
      "skillplane-cloudflare-v2.1.0",
    ]);
    assert.equal(
      await recordCloudflareRelease(
        "skillplane-cloudflare-v2.2.0",
        environment,
        transport,
      ),
      42,
    );
    const create = JSON.parse(requests[1].options.body);
    assert.deepEqual(create.required_contexts, []);
    assert.equal(create.ref, "skillplane-cloudflare-v2.2.0");
    assert.equal(create.production_environment, false);
  });

  it("writes only well-formed single-line GitHub outputs", async () => {
    const root = await mkdtemp(join(tmpdir(), "skillplane-release-outputs-"));
    const output = join(root, "github-output");
    try {
      await writeGithubOutputs({ pkg_path: "packages/local-runtime" }, output);
      assert.equal(await readFile(output, "utf8"), "pkg_path=packages/local-runtime\n");
      await assert.rejects(
        writeGithubOutputs({ pkg_path: "packages/local-runtime\nadmin=true" }, output),
        /must be a single-line value/u,
      );
      await assert.rejects(
        writeGithubOutputs({ "bad-name": "value" }, output),
        /Invalid GitHub output name/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
