import { describe, expect, it } from "vitest";
import { renderSafeMarkdown } from "../../packages/ui/src/markdown.js";
import { createSkillBundleFixture } from "../../packages/testing/src/skill-bundles.js";
import { validateBundleArchive } from "../../packages/storage/src/validate.js";

function corruptArchivePath(
  archive: Uint8Array,
  path: string,
  replacementOffset: number,
): Uint8Array {
  const bytes = archive.slice();
  const encodedPath = new TextEncoder().encode(path);
  let replacements = 0;
  for (let offset = 0; offset <= bytes.length - encodedPath.length; offset += 1) {
    if (encodedPath.every((byte, index) => bytes[offset + index] === byte)) {
      bytes[offset + replacementOffset] = 0xff;
      replacements += 1;
      offset += encodedPath.length - 1;
    }
  }
  expect(replacements).toBe(2);
  return bytes;
}

describe("release-boundary content security", () => {
  it("rejects NFC-equivalent paths before storage", async () => {
    const archive = await createSkillBundleFixture({
      name: "Unicode collision",
      slug: "unicode-collision",
      skillMarkdown: "# Unicode collision\n",
      files: {
        "references/café.md": "composed",
        "references/cafe\u0301.md": "decomposed",
      },
    });

    await expect(validateBundleArchive(archive)).rejects.toMatchObject({
      code: "SKILL_PATH_DUPLICATE",
    });
  });

  it("rejects invalid ZIP filename encoding before extraction", async () => {
    const archive = await createSkillBundleFixture({
      name: "Filename encoding",
      slug: "filename-encoding",
      skillMarkdown: "# Filename encoding\n",
      files: { "references/a.md": "content" },
    });
    const hostile = corruptArchivePath(
      archive,
      "references/a.md",
      "references/".length,
    );

    await expect(validateBundleArchive(hostile)).rejects.toMatchObject({
      code: "SKILL_PATH_INVALID",
    });
  });

  it("neutralizes active Markdown and unsafe URL protocols", () => {
    const rendered = renderSafeMarkdown(
      [
        "<script>globalThis.compromised = true</script>",
        "[javascript](javascript:alert(1))",
        "![data](data:text/html;base64,PHNjcmlwdD4=)",
        "[safe](https://skillplane.dev/docs)",
      ].join("\n\n"),
    );

    expect(rendered).not.toContain("<script");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).not.toContain("data:text");
    expect(rendered).toContain('rel="noreferrer noopener"');
  });
});
