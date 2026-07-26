import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createTestBundle } from "../support/bundle-fixture.js";
import { validateBundleArchive } from "../../src/validate.js";

async function expectBundleCode(
  archive: Uint8Array,
  code:
    | "SKILL_BUNDLE_INVALID"
    | "SKILL_BUNDLE_TOO_LARGE"
    | "SKILL_PATH_INVALID"
    | "SKILL_PATH_DUPLICATE"
    | "SKILL_LINK_INVALID",
): Promise<void> {
  await expect(validateBundleArchive(archive)).rejects.toMatchObject({ code });
}

describe("hostile skill bundle rejection", () => {
  it("rejects traversal, case-fold collisions, and symbolic links", async () => {
    await expectBundleCode(
      zipSync({
        "../outside": strToU8("secret"),
        "SKILL.md": strToU8("# Review"),
        "skill.json": strToU8("{}"),
      }),
      "SKILL_PATH_INVALID",
    );
    await expectBundleCode(
      zipSync({
        "SKILL.md": strToU8("# Review"),
        "skill.json": strToU8("{}"),
        "references/Policy.md": strToU8("one"),
        "references/policy.md": strToU8("two"),
      }),
      "SKILL_PATH_DUPLICATE",
    );
    await expectBundleCode(
      zipSync({
        "SKILL.md": strToU8("# Review"),
        "skill.json": strToU8("{}"),
        "references/current": [
          strToU8("../../private"),
          { attrs: 0o120777 << 16, os: 3 },
        ],
      }),
      "SKILL_LINK_INVALID",
    );
  });

  it("enforces the per-file and total expanded-byte limits", async () => {
    const oversizedFile = await createTestBundle({
      "SKILL.md": new Uint8Array(5 * 1024 * 1024 + 1),
    });
    await expectBundleCode(oversizedFile, "SKILL_BUNDLE_TOO_LARGE");

    const files: Record<string, Uint8Array | string> = {
      "SKILL.md": "# Expansion limit\n",
    };
    for (let index = 0; index < 6; index += 1) {
      files[`assets/part-${String(index)}.bin`] = new Uint8Array(4_500_000);
    }
    await expectBundleCode(await createTestBundle(files), "SKILL_BUNDLE_TOO_LARGE");
  });

  it("enforces the 1,000-entry inventory limit before extraction", async () => {
    const files: Record<string, string> = { "SKILL.md": "# Too many\n" };
    for (let index = 0; index < 1_000; index += 1) {
      files[`references/file-${String(index).padStart(4, "0")}.md`] = "x";
    }
    await expectBundleCode(await createTestBundle(files), "SKILL_BUNDLE_TOO_LARGE");
  });

  it("rejects undeclared content and manifest digest substitution", async () => {
    const undeclared = zipSync({
      "SKILL.md": strToU8("# Review"),
      "skill.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          name: "Review",
          slug: "review",
          description: "",
          tags: [],
          entrypoint: "SKILL.md",
          files: [],
        }),
      ),
    });
    await expectBundleCode(undeclared, "SKILL_BUNDLE_INVALID");

    const content = "# Substituted\n";
    const substituted = zipSync({
      "SKILL.md": strToU8(content),
      "skill.json": strToU8(
        JSON.stringify({
          formatVersion: 1,
          name: "Review",
          slug: "review",
          description: "",
          tags: [],
          entrypoint: "SKILL.md",
          files: [
            {
              path: "SKILL.md",
              sha256: "0".repeat(64),
              byteSize: strToU8(content).byteLength,
              mediaType: "text/markdown; charset=utf-8",
            },
          ],
        }),
      ),
    });
    await expectBundleCode(substituted, "SKILL_BUNDLE_INVALID");
  });
});
