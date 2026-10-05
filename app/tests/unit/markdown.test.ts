import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markdownConstraintMessage,
  markdownDiagnostics,
} from "../../src/lib/markdown/diagnostics.js";
import { resetMarkdownEditorLoader } from "../../src/lib/markdown/load-editor.js";

beforeEach(() => {
  resetMarkdownEditorLoader();
});

afterEach(() => {
  resetMarkdownEditorLoader();
});

describe("shared Markdown editor diagnostics", () => {
  it("surfaces actionable diagnostics for raw HTML without changing the source", () => {
    const source = "# Title\n\n<div>keep</div>\n";
    const diagnostics = markdownDiagnostics(source);
    expect(diagnostics.some((entry) => entry.code === "MDFN_RAW_HTML_DISABLED")).toBe(
      true,
    );
    expect(source).toContain("<div>keep</div>");
  });

  it("blocks empty, character-heavy, and byte-heavy Markdown", () => {
    expect(markdownConstraintMessage("", { required: true })).toBe(
      "Markdown is required.",
    );
    expect(markdownConstraintMessage("abcd", { maxCharacters: 3 })).toContain(
      "character limit",
    );
    expect(markdownConstraintMessage("😀", { maxBytes: 3 })).toContain("byte limit");
    expect(
      markdownConstraintMessage("ready", {
        required: true,
        maxBytes: 10,
        maxCharacters: 10,
      }),
    ).toBe("");
  });
});
