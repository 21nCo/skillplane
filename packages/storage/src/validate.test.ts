import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { createTestBundle } from "../tests/support/bundle-fixture.js";
import { canonicalizeBundle } from "./canonicalize.js";
import { stableJson } from "./manifest.js";
import { validateBundleArchive } from "./validate.js";
import type { BundleValidationError } from "./validate.js";

async function expectCode(
  operation: Promise<unknown>,
  code: BundleValidationError["code"],
) {
  await expect(operation).rejects.toMatchObject({ code });
}

describe("bundle validation", () => {
  it("accepts the complete portable layout and rejects a missing SKILL.md", async () => {
    const valid = await createTestBundle({
      "SKILL.md": "# Review\n",
      "assets/logo.svg": "<svg></svg>",
      "references/checklist.md": "check",
      "scripts/check.sh": "exit 0",
    });
    const result = await validateBundleArchive(valid);
    expect(result.files.size).toBe(5);

    const skillOnly = zipSync({
      "skill.json": strToU8(
        stableJson({
          formatVersion: 1,
          name: "Broken",
          slug: "broken",
          description: "",
          tags: [],
          entrypoint: "SKILL.md",
          files: [],
        }),
      ),
    });
    await expectCode(validateBundleArchive(skillOnly), "SKILL_BUNDLE_INVALID");
  });

  it.each([
    ["parent traversal", "../secret", "SKILL_PATH_INVALID"],
    ["absolute path", "/secret", "SKILL_PATH_INVALID"],
    ["unsupported root", "other/file.txt", "SKILL_PATH_INVALID"],
  ] as const)("rejects %s", async (_label, path, code) => {
    const archive = zipSync({
      [path]: strToU8("secret"),
      "SKILL.md": strToU8("# Skill"),
      "skill.json": strToU8("{}"),
    });
    await expectCode(validateBundleArchive(archive), code);
  });

  it("rejects case-folded duplicates and symbolic links", async () => {
    const duplicate = zipSync({
      "SKILL.md": strToU8("# Skill"),
      "skill.json": strToU8("{}"),
      "references/Readme.md": strToU8("one"),
      "references/readme.md": strToU8("two"),
    });
    await expectCode(validateBundleArchive(duplicate), "SKILL_PATH_DUPLICATE");

    const symlink = zipSync({
      "SKILL.md": strToU8("# Skill"),
      "skill.json": strToU8("{}"),
      "references/link": [strToU8("../../secret"), { attrs: 0o120777 << 16, os: 3 }],
    });
    await expectCode(validateBundleArchive(symlink), "SKILL_LINK_INVALID");
  });

  it("rejects declared expansion before extracting content", async () => {
    const archive = await createTestBundle({ "SKILL.md": "# Skill\n" });
    const patched = archive.slice();
    let central = -1;
    for (let index = 0; index <= patched.length - 4; index += 1) {
      if (
        patched[index] === 0x50 &&
        patched[index + 1] === 0x4b &&
        patched[index + 2] === 0x01 &&
        patched[index + 3] === 0x02
      ) {
        central = index;
        break;
      }
    }
    expect(central).toBeGreaterThanOrEqual(0);
    const oversized = 26 * 1024 * 1024;
    patched[central + 24] = oversized & 0xff;
    patched[central + 25] = (oversized >>> 8) & 0xff;
    patched[central + 26] = (oversized >>> 16) & 0xff;
    patched[central + 27] = (oversized >>> 24) & 0xff;
    await expectCode(canonicalizeBundle(patched), "SKILL_BUNDLE_TOO_LARGE");
  });
});
