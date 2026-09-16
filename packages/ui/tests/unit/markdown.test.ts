import { describe, expect, it } from "vitest";
import { serializeMarkdown } from "@mdfn/markdown";
import {
  SKILLPLANE_MARKDOWN_OPTIONS,
  SKILLPLANE_MARKDOWN_PROFILE_NAME,
  inspectSkillplaneMarkdown,
  parseSkillplaneMarkdown,
  renderSafeMarkdown,
  renderSkillplaneMarkdown,
} from "../../src/index.js";

const SECURITY_FIXTURE =
  '# Safe\n\n<script>alert("x")</script>\n\n[x](javascript:alert(1)) [web](https://example.com)\n\n![bad](data:text/html,x)';

const PRESERVATION_FIXTURE = [
  "# Purpose",
  "",
  "Use the checklist.",
  "",
  "```ts",
  "const value = 1;",
  "```",
  "",
  "| Col | Value |",
  "| --- | ----- |",
  "| a   | b     |",
  "",
  "- [ ] pending",
  "- [x] done",
  "",
  '<unknown-widget id="keep"></unknown-widget>',
  "",
].join("\n");

describe("Skillplane Markdown profile", () => {
  it("names the shared authoring and rendering profile", () => {
    expect(SKILLPLANE_MARKDOWN_PROFILE_NAME).toBe("skillplane.markdown.v1");
    expect(inspectSkillplaneMarkdown("# Title\n").profile).toBe(
      SKILLPLANE_MARKDOWN_PROFILE_NAME,
    );
  });

  it("renders Markdown while neutralizing raw HTML and unsafe URLs", () => {
    const html = renderSafeMarkdown(SECURITY_FIXTURE);
    expect(html).toContain("<h1>Safe</h1>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain('rel="noreferrer noopener"');
  });

  it("keeps preview and read-only rendering on the same profile", () => {
    const html = renderSafeMarkdown(SECURITY_FIXTURE);
    expect(html).toBe(renderSkillplaneMarkdown(SECURITY_FIXTURE).html);
    expect(html).toContain("https://example.com");
  });

  it("preserves untouched source and unsupported syntax", () => {
    const parsed = parseSkillplaneMarkdown(PRESERVATION_FIXTURE);
    const serialized = serializeMarkdown({
      document: parsed.document,
      originalSource: PRESERVATION_FIXTURE,
      options: SKILLPLANE_MARKDOWN_OPTIONS,
    });
    expect(parsed.source).toBe(PRESERVATION_FIXTURE);
    expect(serialized.markdown).toBe(PRESERVATION_FIXTURE);
    expect(serialized.preservation.exactUntouched).toBe(true);
    expect(inspectSkillplaneMarkdown(PRESERVATION_FIXTURE).html).toContain(
      "unknown-widget",
    );
    expect(
      parsed.diagnostics.some((entry) => entry.code === "MDFN_RAW_HTML_DISABLED"),
    ).toBe(true);
    expect(() => renderSkillplaneMarkdown(PRESERVATION_FIXTURE)).not.toThrow();
  });

  it("permits safe relative, fragment, and mailto links", () => {
    const html = renderSafeMarkdown(
      "[root](/docs) [rel](./guide.md) [guide](guide.md) [frag](#section) [mail](mailto:ops@example.com)",
    );
    expect(html).toContain('href="/docs"');
    expect(html).toContain('href="./guide.md"');
    expect(html).toContain('href="guide.md"');
    expect(html).toContain('href="#section"');
    expect(html).toContain('href="mailto:ops@example.com"');
    expect(html).not.toContain('href="//example.com"');
  });

  it("rejects protocol-relative URLs", () => {
    const html = renderSafeMarkdown("[bad](//example.com/secret)");
    expect(html).not.toContain("//example.com/secret");
  });
});
