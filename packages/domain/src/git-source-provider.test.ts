import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { gitSourceConfig, PublicGitHubSourceProvider } from "./git-source-provider.js";
const sha = "a".repeat(40),
  treeSha = "b".repeat(40);
function fixture(
  files: Record<string, string>,
  options: {
    symlink?: string;
    truncated?: boolean;
    wrongBlob?: boolean;
    status?: number;
  } = {},
) {
  const blobs = new Map<string, { sha: string; encoding: string; content: string }>();
  const tree = Object.entries(files).map(([path, content]) => {
    const bytes = Buffer.from(content),
      id = createHash("sha1")
        .update(`blob ${bytes.length}\0`)
        .update(bytes)
        .digest("hex");
    blobs.set(id, { sha: id, encoding: "base64", content: bytes.toString("base64") });
    return {
      path,
      sha: id,
      size: bytes.length,
      type: "blob",
      mode: options.symlink === path ? "120000" : "100644",
    };
  });
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    calls.push(url);
    let data: unknown;
    if (url.includes("/commits/")) data = { sha, commit: { tree: { sha: treeSha } } };
    else if (url.includes("/git/trees/"))
      data = { truncated: options.truncated ?? false, tree };
    else {
      const blob = blobs.get(url.split("/").at(-1) ?? "");
      data = options.wrongBlob
        ? { ...blob, content: Buffer.from("bad").toString("base64") }
        : blob;
    }
    return new Response(JSON.stringify(data), { status: options.status ?? 200 });
  };
  return { provider: new PublicGitHubSourceProvider(fetcher), calls };
}
const markdown = (name: string) =>
  `---\nname: ${name}\ndescription: >\n  A repeatable review\n  workflow\n---\n# ${name}\nInspect evidence.\n`;
describe("public GitHub source provider", () => {
  it("canonicalizes safe repositories and validates ref/path policies", () => {
    expect(
      gitSourceConfig({
        repositoryUrl: "https://github.com/owner/skills.git",
        path: null,
      }),
    ).toMatchObject({
      repositoryUrl: "https://github.com/owner/skills",
      ref: "HEAD",
      refPolicy: "track",
      path: null,
    });
    for (const repositoryUrl of [
      "http://github.com/a/b",
      "https://github.com.evil/a/b",
      "https://token@github.com/a/b",
      "https://github.com/a/b?token=secret",
      "file:///a/b",
    ])
      expect(() => gitSourceConfig({ repositoryUrl })).toThrow();
    for (const path of ["../skills", "/skills", "a\\b", "a/../b", "a//b"])
      expect(() =>
        gitSourceConfig({ repositoryUrl: "https://github.com/a/b", path }),
      ).toThrow();
    expect(() =>
      gitSourceConfig({
        repositoryUrl: "https://github.com/a/b",
        refPolicy: "pin",
        ref: "main",
      }),
    ).toThrow();
  });
  it("discovers multiple conventional roots and pins apply reads to the preview commit", async () => {
    const { provider, calls } = fixture({
      "skills/design/SKILL.md": markdown("Design review"),
      "skills/review/SKILL.md": markdown("Code review"),
      "skills/review/scripts/check.sh": "#!/bin/sh\nexit 0\n",
      "README.md": "Repo documentation",
    });
    const snapshot = await provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
      sha,
    );
    expect(snapshot.commitSha).toBe(sha);
    expect(snapshot.skills.map((s) => s.bundle?.skill.slug)).toEqual([
      "design-review",
      "code-review",
    ]);
    expect(snapshot.skills[1]?.bundle?.skill.description).toContain(
      "repeatable review workflow",
    );
    expect(calls[0]?.endsWith(`/commits/${sha}`)).toBe(true);
    expect(calls.every((c) => c.startsWith("https://api.github.com/repos/a/b/"))).toBe(
      true,
    );
  });
  it("handles a single root and reports missing, nested, and malformed roots", async () => {
    const { provider } = fixture({
      "a/SKILL.md": markdown("Review"),
      "a/child/SKILL.md": markdown("Nested"),
    });
    const all = await provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
    );
    expect(all.skills[0]?.error).toContain("Nested");
    const one = await provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b", path: "a/child" }),
    );
    expect(one.skills[0]?.bundle?.skill.slug).toBe("nested");
    const missing = await provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b", path: "missing" }),
    );
    expect(missing.skills[0]?.error).toContain("No SKILL.md");
    const bad = await fixture({ "SKILL.md": "No frontmatter" }).provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
    );
    expect(bad.skills[0]?.bundle).toBeNull();
  });
  it("rejects links, unsupported files, suspected credentials and blob mismatches", async () => {
    for (const options of [{ symlink: "SKILL.md" }, { wrongBlob: true }]) {
      const r = await fixture(
        { "SKILL.md": markdown("Review") },
        options,
      ).provider.snapshot(gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }));
      expect(r.skills[0]?.bundle).toBeNull();
    }
    for (const files of [
      { "SKILL.md": markdown("Review"), ".env": "SECRET=do-not-import" },
      {
        "SKILL.md": markdown("Review"),
        "scripts/key.txt": "-----BEGIN " + "PRIVATE KEY-----\nexample",
      },
    ]) {
      const r = await fixture(files).provider.snapshot(
        gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
      );
      expect(r.skills[0]?.bundle).toBeNull();
    }
  });
  it("preserves common license and supplemental roots and rejects YAML alias expansion", async () => {
    const config = gitSourceConfig({ repositoryUrl: "https://github.com/a/b" });
    const r = await fixture({
      "SKILL.md": markdown("Review"),
      "LICENSE.txt": "Example permissive license",
      "templates/review.md": "# Review",
      "agents/openai.yaml": "display_name: Review",
    }).provider.snapshot(config);
    expect(r.skills[0]?.bundle?.manifest.files.map((f) => f.path)).toContain(
      "LICENSE.txt",
    );
    const alias = await fixture({
      "SKILL.md": "---\nname: &name Review\ndescription: *name\n---\n# Review\n",
    }).provider.snapshot(config);
    expect(alias.skills[0]?.bundle).toBeNull();
  });
  it("bounds repository-wide skill discovery", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 33 }, (_, i) => [
        `skill-${String(i)}/SKILL.md`,
        markdown(`Review ${String(i)}`),
      ]),
    );
    await expect(
      fixture(files).provider.snapshot(
        gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
      ),
    ).rejects.toThrow("32 skills");
  });
  it("rejects incomplete trees, provider errors and bounded oversized responses", async () => {
    const config = gitSourceConfig({ repositoryUrl: "https://github.com/a/b" });
    await expect(
      fixture({}, { truncated: true }).provider.snapshot(config),
    ).rejects.toThrow("incomplete");
    await expect(
      fixture({}, { status: 429 }).provider.snapshot(config),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    const large = new PublicGitHubSourceProvider(
      async () => new Response("x".repeat(1024 * 1024 + 1)),
    );
    await expect(large.snapshot(config)).rejects.toThrow("limit");
  });
});
