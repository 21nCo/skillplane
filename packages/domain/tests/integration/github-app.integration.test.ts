import { afterEach, describe, expect, it } from "vitest";
import {
  AuthenticatedGitHubSourceProvider,
  GitHubRefConflictError,
  PublicGitHubSourceProvider,
  gitSourceConfig,
  selectGitSourceProvider,
} from "../../src/git-source-provider.js";
import { GitHubApp, GitHubAuthFailedError } from "../../src/github-app.js";
import { appPrivateKeyPem, startFakeGitHub, type FakeGitHub } from "../fake-github.js";

const skill = `---\nname: Private Review\ndescription: Reviews private code\n---\n# Review\n`;
let github: FakeGitHub | null = null;

afterEach(async () => {
  await github?.close();
  github = null;
});

async function setup() {
  github = await startFakeGitHub({
    "skills/review/SKILL.md": skill,
    "README.md": "private\n",
  });
  // Node's fetch reaches the fake server; production fetches api.github.com.
  const app = new GitHubApp(
    { appId: "123456", privateKeyPem: appPrivateKeyPem },
    { apiBaseUrl: github.baseUrl },
  );
  const provider = new AuthenticatedGitHubSourceProvider(app, github.installationId);
  const repositoryUrl = `https://github.com/${github.repository}`;
  return { github, app, provider, repositoryUrl };
}

describe("GitHub App installation against a fake GitHub", () => {
  it("snapshots a private repository with a read-only installation token", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const snapshot = await provider.snapshot(
      gitSourceConfig({ repositoryUrl, ref: "main", path: "skills/review" }),
    );
    expect(snapshot.commitSha).toBe(github.head());
    expect(snapshot.skills).toEqual([
      expect.objectContaining({ path: "skills/review", error: null }),
    ]);
    expect(snapshot.skills[0]?.bundle?.skill.slug).toBe("private-review");
    // One mint served the whole snapshot, scoped to the repository and read.
    expect(github.mints).toEqual([
      { repositories: ["private-skills"], permissions: { contents: "read" } },
    ]);
  });

  it("selects the authenticated provider only for a source with an installation", async () => {
    const { app, github } = await setup();
    expect(
      selectGitSourceProvider({ installationId: github.installationId }, { app }),
    ).toBeInstanceOf(AuthenticatedGitHubSourceProvider);
    expect(selectGitSourceProvider({ installationId: null }, { app })).toBeInstanceOf(
      PublicGitHubSourceProvider,
    );
    expect(
      selectGitSourceProvider({ installationId: null }, { app: null }),
    ).toBeInstanceOf(PublicGitHubSourceProvider);
    expect(() => selectGitSourceProvider({ installationId: 7 }, { app: null })).toThrow(
      expect.objectContaining({ code: "SERVICE_UNAVAILABLE" }),
    );
  });

  it("reports an unknown ref as a validation error but a hidden repository as auth_failed", async () => {
    const { github, provider, repositoryUrl } = await setup();
    await expect(
      provider.snapshot(gitSourceConfig({ repositoryUrl, ref: "missing" })),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    github.hideRepository();
    await expect(
      provider.snapshot(gitSourceConfig({ repositoryUrl, ref: "main" })),
    ).rejects.toBeInstanceOf(GitHubAuthFailedError);
  });

  it("maps a revoked installation to auth_failed after one fresh mint", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const config = gitSourceConfig({ repositoryUrl, ref: "main" });
    await provider.snapshot(config);
    github.revoke();
    await expect(provider.snapshot(config)).rejects.toMatchObject({
      code: "GIT_SOURCE_AUTH_FAILED",
      details: { reason: "auth_failed" },
    });
    // The cached token was rejected (401), so a fresh mint was attempted and
    // GitHub answered it with 404 for the removed installation.
    expect(github.mints).toHaveLength(2);
  });

  it("writes a blob, tree and commit and moves the branch from the expected SHA", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const parent = github.head();
    const blob = await provider.createBlob(
      repositoryUrl,
      new TextEncoder().encode(skill.replace("# Review", "# Review v2")),
    );
    const tree = await provider.createTree(repositoryUrl, {
      baseTree: github.treeOf(parent),
      entries: [{ path: "skills/review/SKILL.md", mode: "100644", sha: blob }],
    });
    const commit = await provider.createCommit(repositoryUrl, {
      message: "Publish private-review v2",
      tree,
      parents: [parent],
    });
    await provider.updateRef(repositoryUrl, {
      branch: "main",
      commitSha: commit,
      expectedSha: parent,
    });
    expect(github.head()).toBe(commit);
    expect(github.blob("skills/review/SKILL.md")).toContain("# Review v2");
    expect(github.blob("README.md")).toBe("private\n");
    // Writes used a separate write-scoped token for the same repository.
    expect(github.mints.map((m) => m.permissions.contents)).toContain("write");
    expect(github.mints.every((m) => m.repositories.join() === "private-skills")).toBe(
      true,
    );
  });

  async function commitOn(
    provider: AuthenticatedGitHubSourceProvider,
    repositoryUrl: string,
    parent: string,
    message: string,
  ) {
    return provider.createCommit(repositoryUrl, {
      message,
      tree: github?.treeOf(parent) ?? "",
      parents: [parent],
    });
  }

  it("refuses a stale expected SHA and a branch that moves during the update", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const parent = github.head();
    const commit = await commitOn(provider, repositoryUrl, parent, "Publish");

    // Stale before the update: the branch already moved.
    const moved = github.pushExternal();
    await expect(
      provider.updateRef(repositoryUrl, {
        branch: "main",
        commitSha: commit,
        expectedSha: parent,
      }),
    ).rejects.toBeInstanceOf(GitHubRefConflictError);
    expect(github.head()).toBe(moved);

    // Stale during the update: the branch moves after the read and the
    // atomic beforeOid check refuses it; the branch keeps the other commit.
    const next = await commitOn(provider, repositoryUrl, moved, "Publish again");
    let raced = "";
    github.beforeNextRefUpdate(() => {
      raced = github.pushExternal();
    });
    await expect(
      provider.updateRef(repositoryUrl, {
        branch: "main",
        commitSha: next,
        expectedSha: moved,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "stale_ref" } });
    expect(github.head()).toBe(raced);
  });

  it("refuses a branch reset to an older commit between the read and the update", async () => {
    const { github, provider, repositoryUrl } = await setup();
    // A <- B (expected) <- C (new). A reset back to A after the read would let
    // a plain fast-forward update move A to C and silently undo the reset.
    const a = github.head();
    const b = github.pushExternal();
    const c = await commitOn(provider, repositoryUrl, b, "Publish on B");
    github.beforeNextRefUpdate(() => github.resetExternal(a));
    await expect(
      provider.updateRef(repositoryUrl, {
        branch: "main",
        commitSha: c,
        expectedSha: b,
      }),
    ).rejects.toMatchObject({ code: "CONFLICT", details: { reason: "stale_ref" } });
    expect(github.head()).toBe(a);
  });

  it("treats an update applied before its response was lost as success", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const parent = github.head();
    const commit = await commitOn(provider, repositoryUrl, parent, "Publish");
    github.loseNextRefUpdateResponse();
    await provider.updateRef(repositoryUrl, {
      branch: "main",
      commitSha: commit,
      expectedSha: parent,
    });
    expect(github.head()).toBe(commit);
    // A caller retrying the same update finds the branch already there and
    // succeeds without another mutation.
    const mutations = github.requests.filter((r) => r === "POST /graphql").length;
    await provider.updateRef(repositoryUrl, {
      branch: "main",
      commitSha: commit,
      expectedSha: parent,
    });
    expect(github.requests.filter((r) => r === "POST /graphql")).toHaveLength(
      mutations,
    );
    expect(github.head()).toBe(commit);
  });

  it("reports a missing branch in a visible repository as a stale ref", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const parent = github.head();
    const commit = await commitOn(provider, repositoryUrl, parent, "Publish");
    await expect(
      provider.updateRef(repositoryUrl, {
        branch: "gone",
        commitSha: commit,
        expectedSha: parent,
      }),
    ).rejects.toBeInstanceOf(GitHubRefConflictError);
  });

  it("maps a repository hidden after the token was minted to auth_failed on every path", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const parent = github.head();
    const commit = await commitOn(provider, repositoryUrl, parent, "Publish");
    const config = gitSourceConfig({ repositoryUrl, ref: "main" });
    await provider.snapshot(config);
    github.hideRepository();
    // Cached read and write tokens now see 404 for the branch, objects and
    // writes; the repository probe tells lost access from a missing object.
    await expect(
      provider.updateRef(repositoryUrl, {
        branch: "main",
        commitSha: commit,
        expectedSha: parent,
      }),
    ).rejects.toBeInstanceOf(GitHubAuthFailedError);
    await expect(
      provider.createTree(repositoryUrl, {
        baseTree: github.treeOf(parent),
        entries: [{ path: "README.md", mode: "100644", sha: null }],
      }),
    ).rejects.toBeInstanceOf(GitHubAuthFailedError);
    await expect(provider.snapshot(config)).rejects.toBeInstanceOf(
      GitHubAuthFailedError,
    );
    expect(github.head()).toBe(parent);
  });

  it("maps a repository hidden during a snapshot's content reads to auth_failed", async () => {
    const { github, provider, repositoryUrl } = await setup();
    github.beforeNextRequest(/\/git\/trees\//u, () => github.hideRepository());
    await expect(
      provider.snapshot(gitSourceConfig({ repositoryUrl, ref: "main" })),
    ).rejects.toBeInstanceOf(GitHubAuthFailedError);
  });

  it("treats a secondary rate limit without headers as retryable, not auth_failed", async () => {
    const { github, provider, repositoryUrl } = await setup();
    const parent = github.head();
    const commit = await commitOn(provider, repositoryUrl, parent, "Publish");
    github.throttleNext();
    await expect(
      provider.snapshot(gitSourceConfig({ repositoryUrl, ref: "main" })),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    github.beforeNextRequest(/^\/graphql$/u, () => github.throttleNext());
    await expect(
      provider.updateRef(repositoryUrl, {
        branch: "main",
        commitSha: commit,
        expectedSha: parent,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect(github.head()).toBe(parent);
    // Nothing was revoked: the same provider still reads and writes.
    await provider.updateRef(repositoryUrl, {
      branch: "main",
      commitSha: commit,
      expectedSha: parent,
    });
    expect(github.head()).toBe(commit);
  });

  it("validates write inputs before calling GitHub", async () => {
    const { github, provider, repositoryUrl } = await setup();
    for (const write of [
      () =>
        provider.createTree(repositoryUrl, {
          baseTree: null,
          entries: [{ path: "../escape", mode: "100644", sha: "a".repeat(40) }],
        }),
      () =>
        provider.createCommit(repositoryUrl, {
          message: "",
          tree: "a".repeat(40),
          parents: [],
        }),
      () =>
        provider.updateRef(repositoryUrl, {
          branch: "../main",
          commitSha: "a".repeat(40),
          expectedSha: "b".repeat(40),
        }),
      () => provider.createBlob("https://example.test/acme/x", new Uint8Array()),
    ])
      await expect(write()).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(github.mints).toHaveLength(0);
  });

  it("keeps public sources unauthenticated", async () => {
    const { github } = await setup();
    const calls: (string | null)[] = [];
    const provider = new PublicGitHubSourceProvider(async (_input, init) => {
      calls.push(new Headers(init?.headers).get("authorization"));
      return new Response("not found", { status: 404 });
    });
    await expect(
      provider.snapshot(
        gitSourceConfig({ repositoryUrl: `https://github.com/${github.repository}` }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED" });
    expect(calls).toEqual([null]);
    expect(github.mints).toHaveLength(0);
  });
});
