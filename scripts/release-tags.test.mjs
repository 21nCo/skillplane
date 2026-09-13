import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  resolveCloudflareRelease,
  resolvePackageRelease,
} from "./lib/release-tags.mjs";

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
      });
      await assert.rejects(
        resolvePackageRelease("skillplane-v1.2.4", root),
        /does not match/u,
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
    assert.throws(
      () => resolveCloudflareRelease(`skillplane-cloudflare-v2.0.0-${"a".repeat(40)}`),
      /must not exceed 54 characters/u,
    );
  });
});
