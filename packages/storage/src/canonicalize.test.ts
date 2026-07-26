import fc from "fast-check";
import { describe, expect, it } from "vitest";
import goldenDigests from "../tests/fixtures/canonical-digests.json" with { type: "json" };
import { createTestBundle } from "../tests/support/bundle-fixture.js";
import { canonicalizeBundle } from "./canonicalize.js";

describe("canonical bundle", () => {
  it("matches the versioned canonical fixture digests", async () => {
    const minimal = await canonicalizeBundle(
      await createTestBundle(
        { "SKILL.md": "# Minimal skill\n" },
        { name: "Minimal skill", slug: "minimal-skill" },
      ),
    );
    const portable = await canonicalizeBundle(
      await createTestBundle(
        {
          "SKILL.md": "# Pull request review\n\nReview for correctness.\n",
          "references/checklist.md": "- Tests\n- Security\n",
          "scripts/check.sh": "#!/bin/sh\nexit 0\n",
        },
        { name: "PR review", slug: "pr-review" },
      ),
    );
    expect({
      minimal: { digest: minimal.digest, byteSize: minimal.bytes.byteLength },
      portable: { digest: portable.digest, byteSize: portable.bytes.byteLength },
    }).toEqual(goldenDigests);
  });

  it("produces byte-identical output across ordering and timestamps", async () => {
    const files = {
      "SKILL.md": "# Pull request review\n\nReview for correctness.\n",
      "references/checklist.md": "- Tests\n- Security\n",
      "scripts/check.sh": "#!/bin/sh\nexit 0\n",
    };
    const first = await createTestBundle(files, {
      slug: "pr-review",
      name: "PR review",
      order: ["scripts/check.sh", "SKILL.md", "references/checklist.md"],
      mtime: new Date("2020-01-02T04:06:00Z"),
    });
    const second = await createTestBundle(files, {
      slug: "pr-review",
      name: "PR review",
      order: ["references/checklist.md", "SKILL.md", "scripts/check.sh"],
      mtime: new Date("2026-07-25T06:00:00Z"),
    });
    const a = await canonicalizeBundle(first);
    const b = await canonicalizeBundle(second);
    expect(a.bytes).toEqual(b.bytes);
    expect(a.digest).toBe(b.digest);
    expect(a.manifest.files.map((file) => file.path)).toEqual([
      "SKILL.md",
      "references/checklist.md",
      "scripts/check.sh",
      "skill.json",
    ]);
  });

  it("is idempotent and preserves every declared file digest", async () => {
    const input = await createTestBundle({
      "SKILL.md": "# One\n",
      "assets/data.txt": "data",
    });
    const first = await canonicalizeBundle(input);
    const second = await canonicalizeBundle(first.bytes);
    expect(second.bytes).toEqual(first.bytes);
    expect(second.manifest).toEqual(first.manifest);
  });

  it("holds determinism over generated portable bundle inventories", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            body: fc.string({ maxLength: 120 }),
            suffix: fc.integer({ min: 0, max: 20 }),
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (values) => {
          const deduplicated = new Map<number, string>();
          for (const value of values) deduplicated.set(value.suffix, value.body);
          const files: Record<string, string> = {
            "SKILL.md": "# Generated skill\n",
          };
          for (const [suffix, body] of deduplicated) {
            files[`references/file-${suffix}.md`] = body;
          }
          const forward = Object.keys(files);
          const reverse = [...forward].reverse();
          const first = await canonicalizeBundle(
            await createTestBundle(files, {
              order: forward,
              mtime: new Date("2010-01-01T00:00:00Z"),
            }),
          );
          const second = await canonicalizeBundle(
            await createTestBundle(files, {
              order: reverse,
              mtime: new Date("2030-12-30T00:00:00Z"),
            }),
          );
          expect(second.bytes).toEqual(first.bytes);
          expect(second.digest).toBe(first.digest);
        },
      ),
      { numRuns: 75, seed: 20_260_725 },
    );
  });
});
