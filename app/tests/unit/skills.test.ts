import { strToU8, unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  buildSkillBundle,
  bytesToBase64,
  inspectSkillBundle,
  markdownFiles,
} from "../../src/lib/skills/bundle.js";
import { renderSafeMarkdown } from "@skillplane/ui";

describe("skill browser utilities", () => {
  it("builds a portable deterministic browser bundle", async () => {
    const options = {
      metadata: {
        name: "PR Review",
        slug: "pr-review",
        description: "Review pull requests",
        tags: ["review", "git", "review"],
      },
      files: new Map([
        ["references/checklist.md", strToU8("- Correctness\n")],
        ["SKILL.md", strToU8("# PR Review\n\nUse the checklist.\n")],
      ]),
    } as const;
    const first = await buildSkillBundle(options);
    const second = await buildSkillBundle({
      ...options,
      files: new Map([...options.files].reverse()),
    });
    expect(first).toEqual(second);
    expect(bytesToBase64(first)).toMatch(/^[A-Za-z0-9+/]+=*$/u);
    const files = unzipSync(first);
    expect(Object.keys(files).sort()).toEqual([
      "SKILL.md",
      "references/checklist.md",
      "skill.json",
    ]);
    expect(inspectSkillBundle(first)).toMatchObject({
      name: "PR Review",
      slug: "pr-review",
      formatVersion: 1,
      fileCount: 3,
    });
  });

  it("rejects malformed bundle previews and missing Markdown", async () => {
    expect(() => inspectSkillBundle(strToU8("not a zip"))).toThrow(
      "not a readable ZIP",
    );
    await expect(
      buildSkillBundle({
        metadata: {
          name: "No content",
          slug: "no-content",
          description: "",
          tags: [],
        },
        files: new Map(),
      }),
    ).rejects.toThrow("SKILL.md is required");
    expect(markdownFiles("# Ready").get("SKILL.md")).toEqual(strToU8("# Ready"));
  });

  it("renders Markdown while neutralizing raw HTML and unsafe URLs", () => {
    const html = renderSafeMarkdown(
      '# Safe\n\n<script>alert("x")</script>\n\n[x](javascript:alert(1)) [web](https://example.com)\n\n![bad](data:text/html,x)',
    );
    expect(html).toContain("<h1>Safe</h1>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain('rel="noreferrer noopener"');
  });
});
