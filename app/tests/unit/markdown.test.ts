import { afterEach, describe, expect, it } from "vitest";
import { markdownDiagnostics } from "../../src/lib/markdown/diagnostics.js";
import { isMarkdownEditorEnabled } from "../../src/lib/markdown/flags.js";

afterEach(() => {
  delete process.env.SKILLPLANE_MDFN_EDITOR;
  delete process.env.SKILLPLANE_MDFN_EDITOR_SKILL_CREATE;
  delete process.env.PUBLIC_SKILLPLANE_MDFN_EDITOR;
  delete process.env.PUBLIC_SKILLPLANE_MDFN_EDITOR_SKILL_CREATE;
});

describe("shared Markdown editor flags and diagnostics", () => {
  it("enables each authoring surface by default", () => {
    expect(isMarkdownEditorEnabled("skill-create")).toBe(true);
    expect(isMarkdownEditorEnabled("skill-amend")).toBe(true);
    expect(isMarkdownEditorEnabled("context-create")).toBe(true);
    expect(isMarkdownEditorEnabled("knowledge-revise")).toBe(true);
    expect(isMarkdownEditorEnabled("note")).toBe(true);
  });

  it("restores the current source control when a surface is rolled back", () => {
    process.env.SKILLPLANE_MDFN_EDITOR_SKILL_CREATE = "0";
    expect(isMarkdownEditorEnabled("skill-create")).toBe(false);
    expect(isMarkdownEditorEnabled("skill-amend")).toBe(true);
    process.env.SKILLPLANE_MDFN_EDITOR = "off";
    expect(isMarkdownEditorEnabled("skill-amend")).toBe(false);
  });

  it("surfaces actionable diagnostics for raw HTML without changing the source", () => {
    const source = "# Title\n\n<div>keep</div>\n";
    const diagnostics = markdownDiagnostics(source);
    expect(diagnostics.some((entry) => entry.code === "MDFN_RAW_HTML_DISABLED")).toBe(
      true,
    );
    expect(source).toContain("<div>keep</div>");
  });
});
