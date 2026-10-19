import { describe, expect, it } from "vitest";
import { strToU8, unzipSync } from "fflate";
import {
  inspectSkillplaneMarkdown,
  renderSafeMarkdown,
  renderSkillplaneMarkdown,
} from "@skillplane/ui";
import {
  buildInstructionsBundle,
  buildSkillBundle,
  bytesToBase64,
  inspectSkillBundle,
  markdownFiles,
} from "../../src/lib/skills/bundle.js";

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

  it("builds an instructions bundle of exactly AGENTS.md and skill.json", async () => {
    const document = "# Conventions\n\nRun the formatter before committing.\n";
    const bundle = await buildInstructionsBundle({
      metadata: {
        name: "Repository conventions",
        slug: "repository-conventions",
        description: "",
        tags: [],
      },
      document,
    });
    const files = unzipSync(bundle);
    expect(Object.keys(files).sort()).toEqual(["AGENTS.md", "skill.json"]);
    expect(new TextDecoder().decode(files["AGENTS.md"])).toBe(document);
    const manifest = JSON.parse(new TextDecoder().decode(files["skill.json"])) as {
      readonly files: readonly { readonly path: string; readonly sha256: string }[];
    };
    const digest = await crypto.subtle.digest("SHA-256", strToU8(document));
    expect(manifest).toMatchObject({
      formatVersion: 1,
      kind: "instructions",
      entrypoint: "AGENTS.md",
      slug: "repository-conventions",
      files: [
        {
          path: "AGENTS.md",
          sha256: Buffer.from(digest).toString("hex"),
          byteSize: strToU8(document).byteLength,
        },
      ],
    });
    await expect(
      buildInstructionsBundle({
        metadata: { name: "Empty", slug: "empty", description: "", tags: [] },
        document: "  \n",
      }),
    ).rejects.toThrow("AGENTS.md is required");
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
    const source =
      '# Safe\n\n<script>alert("x")</script>\n\n[x](javascript:alert(1)) [web](https://example.com)\n\n![bad](data:text/html,x)';
    const html = renderSafeMarkdown(source);
    expect(html).toContain("<h1>Safe</h1>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("data:text");
    expect(html).toContain('rel="noreferrer noopener"');
    expect(html).toBe(renderSkillplaneMarkdown(source).html);
    expect(inspectSkillplaneMarkdown(source).profile).toBe("skillplane.markdown.v1");
  });
});
