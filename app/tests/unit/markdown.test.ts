import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { markdownDiagnostics } from "../../src/lib/markdown/diagnostics.js";
import {
  MARKDOWN_EDITOR_FLAG_NAMES,
  isMarkdownEditorEnabled,
} from "../../src/lib/markdown/flags.js";
import { resetMarkdownEditorLoader } from "../../src/lib/markdown/load-editor.js";

const publicEnv = vi.hoisted(() => ({
  env: {} as Record<string, string | undefined>,
}));

vi.mock("$env/dynamic/public", () => publicEnv);

const FLAG_KEYS = [
  ...MARKDOWN_EDITOR_FLAG_NAMES,
  ...MARKDOWN_EDITOR_FLAG_NAMES.map((name) => `PUBLIC_${name}`),
];

const originalFlags = Object.fromEntries(
  FLAG_KEYS.map((name) => [name, process.env[name]]),
);

function restoreEditorFlags() {
  for (const name of Object.keys(publicEnv.env)) delete publicEnv.env[name];
  for (const name of FLAG_KEYS) {
    const previous = originalFlags[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
}

beforeEach(() => {
  restoreEditorFlags();
  process.env.SKILLPLANE_MDFN_EDITOR = "1";
  resetMarkdownEditorLoader();
});

afterEach(() => {
  restoreEditorFlags();
  resetMarkdownEditorLoader();
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

  it("reads PUBLIC_ runtime values from the dynamic public env", () => {
    publicEnv.env.PUBLIC_SKILLPLANE_MDFN_EDITOR_NOTE = "legacy";
    expect(isMarkdownEditorEnabled("note")).toBe(false);
    expect(isMarkdownEditorEnabled("skill-amend")).toBe(true);
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
