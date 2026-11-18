import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AuthenticatedGitHubSourceProvider,
  GitHubRefConflictError,
  gitSourceConfig,
  PublicGitHubSourceProvider,
} from "./git-source-provider.js";
import { GitHubApp, GitHubAuthFailedError } from "./github-app.js";
const sha = "a".repeat(40),
  treeSha = "b".repeat(40);
function fixture(
  files: Record<string, string>,
  options: {
    symlink?: string;
    truncated?: boolean;
    wrongBlob?: boolean;
    status?: number;
    // Fail only requests whose URL matches, with the given status.
    fail?: { url: RegExp; status: number };
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
    // workerd rejects redirect: "error"; redirects are never followed.
    expect(init?.redirect).toBe("manual");
    if (options.fail?.url.test(url))
      return new Response(JSON.stringify({ message: "Not Found" }), {
        status: options.fail.status,
      });
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
  it("rejects a root AGENTS.md in a skill directory before fetching any blob", async () => {
    const f = fixture({ "SKILL.md": markdown("Review"), "AGENTS.md": "# Agents\n" });
    const r = await f.provider.snapshot(
      gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
    );
    expect(r.skills[0]?.bundle).toBeNull();
    expect(r.skills[0]?.error).toContain('"AGENTS.md"');
    expect(f.calls.filter((url) => url.includes("/git/blobs/"))).toEqual([]);
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
    // A missing repository or ref is permanent; throttling and transport
    // failures stay retryable.
    const notFound = {
      code: "VALIDATION_FAILED",
      status: 400,
      message: "Public repository or ref was not found",
    };
    const retryable = { code: "SERVICE_UNAVAILABLE", status: 503 };
    // GitHub answers an unknown repository with 404 and an unknown branch with 422.
    for (const status of [404, 422])
      await expect(
        fixture({}, { status }).provider.snapshot(config),
      ).rejects.toMatchObject(notFound);
    // A pinned commit that no longer exists is resolved through git/commits.
    for (const status of [404, 422])
      await expect(
        fixture({}, { fail: { url: /\/git\/commits\//, status } }).provider.snapshot(
          config,
          sha,
        ),
      ).rejects.toMatchObject(notFound);
    for (const status of [403, 429, 500])
      await expect(
        fixture({}, { status }).provider.snapshot(config),
      ).rejects.toMatchObject(retryable);
    // Content missing after the commit resolved aborts the whole snapshot,
    // rather than reporting a partial result with an invalid skill.
    const files = { "a/SKILL.md": markdown("Alpha"), "b/SKILL.md": markdown("Beta") };
    for (const url of [/\/git\/trees\//, /\/git\/blobs\//, /\/git\/commits\//])
      for (const status of [404, 422])
        await expect(
          fixture(files, { fail: { url, status } }).provider.snapshot(config),
        ).rejects.toMatchObject(retryable);
    await expect(
      new PublicGitHubSourceProvider(async () => {
        throw new TypeError("fetch failed");
      }).snapshot(config),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
    const large = new PublicGitHubSourceProvider(
      async () => new Response("x".repeat(1024 * 1024 + 1)),
    );
    await expect(large.snapshot(config)).rejects.toThrow("limit");
  });
  it("rejects redirects instead of following them", async () => {
    const config = gitSourceConfig({ repositoryUrl: "https://github.com/a/b" });
    const files = { "a/SKILL.md": markdown("Alpha"), "b/SKILL.md": markdown("Beta") };
    // A renamed repository redirects ref resolution: the source URL must change.
    for (const status of [301, 302, 307, 308]) {
      const f = fixture(files, { fail: { url: /\/commits\//, status } });
      await expect(f.provider.snapshot(config)).rejects.toMatchObject({
        code: "VALIDATION_FAILED",
        status: 400,
        message: "GitHub redirected the repository; use its current URL",
      });
      expect(f.calls).toHaveLength(1);
    }
    // A redirected tree or blob aborts the snapshot as retryable.
    for (const url of [/\/git\/trees\//, /\/git\/blobs\//]) {
      const f = fixture(files, { fail: { url, status: 302 } });
      await expect(f.provider.snapshot(config)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
        status: 503,
      });
      expect(
        f.calls.every((c) => c.startsWith("https://api.github.com/repos/a/b/")),
      ).toBe(true);
    }
    const opaque = fixture(files);
    const provider = new PublicGitHubSourceProvider(async (input, init) => {
      if (!String(input).includes("/git/blobs/")) return opaque.fetcher(input, init);
      const response = new Response(null, { status: 200 });
      Object.defineProperty(response, "type", { value: "opaqueredirect" });
      return response;
    });
    await expect(provider.snapshot(config)).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
  });
  describe("default fetcher", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    it("calls the global fetch with the receiver workerd requires", async () => {
      const f = fixture({ "SKILL.md": markdown("Review") });
      // workerd throws Illegal invocation when fetch runs with another receiver.
      vi.stubGlobal(
        "fetch",
        function (this: unknown, ...args: Parameters<typeof fetch>) {
          if (this !== undefined && this !== globalThis)
            throw new TypeError("Illegal invocation");
          return f.fetcher(...args);
        },
      );
      const snapshot = await new PublicGitHubSourceProvider().snapshot(
        gitSourceConfig({ repositoryUrl: "https://github.com/a/b" }),
      );
      expect(snapshot).toMatchObject({
        commitSha: sha,
        skills: [{ path: "", error: null }],
      });
    });
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

describe("authenticated GitHub source provider", () => {
  const appKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  const repositoryUrl = "https://github.com/acme/skills";
  const head = "c".repeat(40),
    next = "d".repeat(40);

  // Mints any requested token and answers repository requests through `route`
  // (method and path after /repos/acme/skills, or "POST /graphql").
  function provider(route: (request: string) => Response | undefined) {
    const seen: string[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/access_tokens")) {
        const body = JSON.parse(String(init?.body)) as {
          permissions: { contents: string };
        };
        return Response.json({
          token: `ghs_${"1".repeat(36)}`,
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
          permissions: body.permissions,
          repositories: [{ full_name: "acme/skills" }],
        });
      }
      const request = `${init?.method ?? "GET"} ${url.pathname.replace("/repos/acme/skills", "")}`;
      seen.push(request);
      return route(request) ?? new Response("{}", { status: 404 });
    };
    const app = new GitHubApp({ appId: "1", privateKeyPem: appKey }, { fetcher });
    return { provider: new AuthenticatedGitHubSourceProvider(app, 7), seen };
  }
  const repo = () => Response.json({ full_name: "acme/skills", node_id: "R_1" });
  const ref = (sha: string) => Response.json({ object: { sha, type: "commit" } });

  it("tells a missing object from lost access by probing the repository", async () => {
    // Visible repository: a 404 after resolution is an incomplete snapshot
    // and a 404 write is a missing referenced object, neither auth_failed.
    const visible = provider((request) =>
      request === "GET "
        ? repo()
        : request.startsWith("GET /commits/")
          ? new Response(head)
          : undefined,
    );
    await expect(
      visible.provider.snapshot(gitSourceConfig({ repositoryUrl, ref: "main" })),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(
      visible.provider.createCommit(repositoryUrl, {
        message: "m",
        tree: head,
        parents: [],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    // Hidden repository: the same 404s are auth_failed.
    const hidden = provider((request) =>
      request.startsWith("GET /commits/") ? new Response(head) : undefined,
    );
    await expect(
      hidden.provider.snapshot(gitSourceConfig({ repositoryUrl, ref: "main" })),
    ).rejects.toBeInstanceOf(GitHubAuthFailedError);
    await expect(
      hidden.provider.createCommit(repositoryUrl, {
        message: "m",
        tree: head,
        parents: [],
      }),
    ).rejects.toBeInstanceOf(GitHubAuthFailedError);
  });

  it("decides a refused branch update by where the branch is afterwards", async () => {
    const update = { branch: "main", commitSha: next, expectedSha: head };
    const refused = (type: string) =>
      Response.json({ data: { updateRefs: null }, errors: [{ type, message: "no" }] });
    // Still at the expected commit: a protected branch or rule refusal.
    const rule = provider((request) =>
      request === "GET "
        ? repo()
        : request === "GET /git/ref/heads/main"
          ? ref(head)
          : request === "POST /graphql"
            ? refused("UNPROCESSABLE")
            : undefined,
    );
    await expect(rule.provider.updateRef(repositoryUrl, update)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { reason: "update_rejected" },
    });
    // A GraphQL rate limit is retryable.
    const limited = provider((request) =>
      request === "GET "
        ? repo()
        : request === "GET /git/ref/heads/main"
          ? ref(head)
          : request === "POST /graphql"
            ? refused("RATE_LIMITED")
            : undefined,
    );
    await expect(
      limited.provider.updateRef(repositoryUrl, update),
    ).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
    });
    // The update reached GitHub although it answered with an error.
    let reads = 0;
    const landed = provider((request) =>
      request === "GET "
        ? repo()
        : request === "GET /git/ref/heads/main"
          ? ref(reads++ === 0 ? head : next)
          : request === "POST /graphql"
            ? new Response("{}", { status: 502 })
            : undefined,
    );
    await expect(
      landed.provider.updateRef(repositoryUrl, update),
    ).resolves.toBeUndefined();
    // A branch already at the new commit needs no mutation.
    const done = provider((request) =>
      request === "GET /git/ref/heads/main" ? ref(next) : undefined,
    );
    await done.provider.updateRef(repositoryUrl, update);
    expect(done.seen).toEqual(["GET /git/ref/heads/main"]);
  });

  it("keeps the original error after a lost update response unless the branch landed", async () => {
    const update = { branch: "main", commitSha: next, expectedSha: head };
    const other = "e".repeat(40);
    // The mutation response is lost (502) and the branch then sits at a third
    // commit: the original retryable 503, not stale_ref.
    let reads = 0;
    const moved = provider((request) =>
      request === "GET "
        ? repo()
        : request === "GET /git/ref/heads/main"
          ? ref(reads++ === 0 ? head : other)
          : request === "POST /graphql"
            ? new Response("{}", { status: 502 })
            : undefined,
    );
    const lost = moved.provider.updateRef(repositoryUrl, update);
    await expect(lost).rejects.toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      status: 503,
    });
    await expect(lost).rejects.not.toBeInstanceOf(GitHubRefConflictError);
    // The retry's first read reports the move as stale_ref.
    await expect(
      moved.provider.updateRef(repositoryUrl, update),
    ).rejects.toBeInstanceOf(GitHubRefConflictError);
    // A re-read that fails, here with lost access, is folded into the original
    // error instead of replacing it.
    let probes = 0,
      hiddenReads = 0;
    const hidden = provider((request) =>
      request === "GET "
        ? probes++ === 0
          ? repo()
          : undefined
        : request === "GET /git/ref/heads/main"
          ? hiddenReads++ === 0
            ? ref(head)
            : undefined
          : request === "POST /graphql"
            ? new Response("{}", { status: 502 })
            : undefined,
    );
    const folded = hidden.provider.updateRef(repositoryUrl, update);
    await expect(folded).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    await expect(folded).rejects.not.toBeInstanceOf(GitHubAuthFailedError);
    expect(hidden.seen).toEqual([
      "GET /git/ref/heads/main",
      "GET ",
      "POST /graphql",
      "GET /git/ref/heads/main",
      "GET ",
    ]);
  });

  it("rejects an invalid expected commit before calling GitHub", async () => {
    const none = provider(() => undefined);
    await expect(
      none.provider.updateRef(repositoryUrl, {
        branch: "main",
        commitSha: next,
        expectedSha: "not-a-commit",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      status: 400,
      message: "Invalid expected commit",
    });
    expect(none.seen).toEqual([]);
  });
});
