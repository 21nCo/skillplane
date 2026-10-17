import { createHash, randomBytes } from "node:crypto";
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
    extra?: { path: string; mode: string; type: string; sha: string; size?: number }[];
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
  tree.push(...(options.extra ?? []).map((e) => ({ size: 0, ...e })));
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    let data: unknown;
    if (url.includes("/git/commits/")) data = { sha, tree: { sha: treeSha } };
    else if (url.includes("/commits/")) {
      // Ref resolution must request the bare SHA, never the diff-bearing resource.
      expect(new Headers(init?.headers).get("accept")).toBe(
        "application/vnd.github.sha",
      );
      return new Response(sha, { status: options.status ?? 200 });
    } else if (url.includes("/git/trees/"))
      data = { truncated: options.truncated ?? false, tree };
    else {
      const blob = blobs.get(url.split("/").at(-1) ?? "");
      data = options.wrongBlob
        ? { ...blob, content: Buffer.from("bad").toString("base64") }
        : blob;
    }
    return new Response(JSON.stringify(data), { status: options.status ?? 200 });
  };
  return { provider: new PublicGitHubSourceProvider(fetcher), calls, fetcher };
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
    expect(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b", path: "SKILL.md" }),
    ).toMatchObject({ path: "" });
    expect(
      gitSourceConfig({
        repositoryUrl: "https://github.com/a/b",
        path: "skills/review/SKILL.md",
      }),
    ).toMatchObject({ path: "skills/review" });
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
    expect(calls[0]?.endsWith(`/git/commits/${sha}`)).toBe(true);
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
      gitSourceConfig({
        repositoryUrl: "https://github.com/a/b",
        path: "a/child/SKILL.md",
      }),
    );
    expect(one.skills[0]?.bundle?.skill.slug).toBe("nested");
    const parent = await fixture({
      "a/SKILL.md": markdown("Parent"),
      "a/scripts/SKILL.md": markdown("Child"),
    }).provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b", path: "a" }),
    );
    expect(parent.skills[0]?.error).toContain("Nested");
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
    expect(r.skills[0]?.bundle?.manifest.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "LICENSE.txt",
        "templates/review.md",
        "agents/openai.yaml",
      ]),
    );
    const alias = await fixture({
      "SKILL.md": "---\nname: &name Review\ndescription: *name\n---\n# Review\n",
    }).provider.snapshot(config);
    expect(alias.skills[0]?.bundle).toBeNull();
  });
  it("rejects duplicate keys and malformed YAML frontmatter", async () => {
    const config = gitSourceConfig({ repositoryUrl: "https://github.com/a/b" });
    for (const front of [
      "name: Review\nname: Other\ndescription: Review",
      "name: [Review\ndescription: Review",
    ]) {
      const r = await fixture({
        "SKILL.md": `---\n${front}\n---\n# Review\n`,
      }).provider.snapshot(config);
      expect(r.skills[0]?.bundle).toBeNull();
    }
  });
  it("reports a skill beyond the request budget as that skill's error before fetching it", async () => {
    const files: Record<string, string> = {
      "big/SKILL.md": markdown("Big"),
      "small/SKILL.md": markdown("Small"),
    };
    for (let i = 0; i < 197; i++) files[`big/assets/f${String(i)}.txt`] = String(i);
    const f = fixture(files);
    const r = await f.provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
    );
    expect(r.skills.find((s) => s.path === "big")?.error).toContain(
      "197 distinct blob",
    );
    expect(r.skills.find((s) => s.path === "small")?.bundle?.skill.slug).toBe("small");
    expect(f.calls).toHaveLength(4);
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
  it("propagates body-stream failures as retryable transport errors", async () => {
    const f = fixture({ "SKILL.md": markdown("Review") });
    const provider = new PublicGitHubSourceProvider(async (input, init) =>
      String(input).includes("/git/blobs/")
        ? new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("connection reset"));
              },
            }),
          )
        : f.fetcher(input, init),
    );
    await expect(
      provider.snapshot(gitSourceConfig({ repositoryUrl: "https://github.com/a/b" })),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
  });
  it("resolves refs without downloading commit diffs", async () => {
    const f = fixture({ "SKILL.md": markdown("Review") });
    const huge = JSON.stringify({
      sha,
      commit: { tree: { sha: treeSha } },
      files: Array.from({ length: 300 }, (_, i) => ({
        filename: `f${String(i)}`,
        patch: "+".repeat(8192),
      })),
    });
    // A diff-bearing commit resource is larger than any commit-metadata bound.
    expect(huge.length).toBeGreaterThan(2 * 1024 * 1024);
    const provider = new PublicGitHubSourceProvider(async (input, init) =>
      /\/repos\/a\/b\/commits\//.test(String(input)) &&
      new Headers(init?.headers).get("accept") !== "application/vnd.github.sha"
        ? new Response(huge)
        : f.fetcher(input, init),
    );
    const r = await provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b", ref: "main" }),
    );
    expect(r.commitSha).toBe(sha);
    expect(r.skills[0]?.bundle?.skill.slug).toBe("review");
    expect(f.calls.slice(0, 3)).toEqual([
      "https://api.github.com/repos/a/b/commits/main",
      `https://api.github.com/repos/a/b/git/commits/${sha}`,
      `https://api.github.com/repos/a/b/git/trees/${treeSha}?recursive=1`,
    ]);
  });
  it("rejects Unicode-normalized and case-folded path twins instead of dropping a file", async () => {
    const config = gitSourceConfig({ repositoryUrl: "https://github.com/a/b" });
    for (const [first, second] of [
      ["assets/\u00e9.txt", "assets/e\u0301.txt"],
      ["assets/Guide.md", "assets/guide.md"],
    ] as const) {
      const r = await fixture({
        "SKILL.md": markdown("Review"),
        [first]: "precomposed",
        [second]: "decomposed",
      }).provider.snapshot(config);
      expect(r.skills[0]?.bundle).toBeNull();
      expect(r.skills[0]?.error).toContain("collide");
    }
  });
  it("ignores unsafe out-of-scope entries and reports unsafe in-scope paths per skill", async () => {
    const deep = `${Array.from({ length: 30 }, (_, i) => `level-${String(i)}`).join("/")}`;
    expect(deep.length).toBeGreaterThan(240);
    const unrelated = [
      { path: "docs/~/notes.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
      { path: "vendor\\win.txt", mode: "100644", type: "blob", sha: "d".repeat(40) },
      {
        path: `${"x/".repeat(150)}long.txt`,
        mode: "100644",
        type: "blob",
        sha: "e".repeat(40),
      },
      { path: "vendor/lib", mode: "160000", type: "commit", sha: "f".repeat(40) },
    ];
    const f = fixture(
      {
        "skills/review/SKILL.md": markdown("Review"),
        [`${deep}/SKILL.md`]: markdown("Deep"),
      },
      { extra: unrelated },
    );
    const one = await f.provider.snapshot(
      gitSourceConfig({
        repositoryUrl: "https://github.com/a/b",
        path: "skills/review",
      }),
    );
    expect(one.skills.map((s) => [s.path, s.bundle?.skill.slug])).toEqual([
      ["skills/review", "review"],
    ]);
    const all = await f.provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
    );
    expect(all.skills.map((s) => s.bundle?.skill.slug)).toEqual(["deep", "review"]);
    expect(f.calls.some((c) => /[cdef]{40}$/.test(c))).toBe(false);
    for (const extra of [
      { path: "s/docs/~/x.md", mode: "100644", type: "blob", sha: "c".repeat(40) },
      { path: "s/notes.txt", mode: "100644", type: "blob", sha: "c".repeat(40) },
      { path: "s/assets/a\\b.txt", mode: "100644", type: "blob", sha: "c".repeat(40) },
    ]) {
      const r = await fixture(
        { "s/SKILL.md": markdown("Scoped"), "t/SKILL.md": markdown("Other") },
        { extra: [extra] },
      ).provider.snapshot(gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }));
      expect(r.skills.find((s) => s.path === "s")?.error).toBeTruthy();
      expect(r.skills.find((s) => s.path === "t")?.bundle?.skill.slug).toBe("other");
    }
  });
  it("rejects submodules, oversized blobs and credential patterns in a skill", async () => {
    const config = gitSourceConfig({ repositoryUrl: "https://github.com/a/b" });
    const gitlink = await fixture(
      { "SKILL.md": markdown("Review") },
      {
        extra: [
          {
            path: "assets/vendor",
            mode: "160000",
            type: "commit",
            sha: "c".repeat(40),
          },
        ],
      },
    ).provider.snapshot(config);
    expect(gitlink.skills[0]?.error).toContain("submodule");
    const limit = 5 * 1024 * 1024;
    const exact = await fixture({
      "SKILL.md": markdown("Review"),
      // Incompressible content stays within the bundle expansion-ratio limit.
      "assets/data.txt": randomBytes(limit / 2).toString("hex"),
    }).provider.snapshot(config);
    expect(exact.skills[0]?.error).toBeNull();
    expect(exact.skills[0]?.bundle?.skill.slug).toBe("review");
    const over = fixture({
      "SKILL.md": markdown("Review"),
      "assets/data.txt": "x".repeat(limit + 1),
    });
    const r = await over.provider.snapshot(config);
    expect(r.skills[0]?.error).toContain("size limit");
    expect(over.calls.some((c) => c.includes("/git/blobs/"))).toBe(false);
    for (const secret of [
      `ghp_${"A".repeat(36)}`,
      `github_pat_${"B".repeat(60)}`,
      `AKIA${"C".repeat(16)}`,
    ]) {
      const leaked = await fixture({
        "SKILL.md": markdown("Review"),
        "references/setup.md": `token = ${secret}\n`,
      }).provider.snapshot(config);
      expect(leaked.skills[0]?.error).toContain("credential");
    }
  }, 30000);
  it("stops the whole snapshot before downloading beyond its aggregate byte budget", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 6; i++) {
      files[`s${i}/SKILL.md`] = markdown(`Skill ${i}`);
      files[`s${i}/assets/data.txt`] = String(i) + "x".repeat(4 * 1024 * 1024);
    }
    const f = fixture(files);
    await expect(
      f.provider.snapshot(gitSourceConfig({ repositoryUrl: "https://github.com/a/b" })),
    ).rejects.toThrow("20 MiB");
    expect(f.calls.length).toBeLessThanOrEqual(12);
  }, 30000);
});
