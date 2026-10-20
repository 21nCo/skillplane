import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const directory = () =>
  realpathSync(mkdtempSync(join(tmpdir(), "skillplane-git-directory-")));
// The sentinel is created and inspected with an explicit environment, not the
// helper under test.
const sentinelGit = (repository: string, args: string[]) =>
  execFileSync("git", ["-C", repository, ...args], {
    env: {
      PATH: process.env.PATH,
      GIT_CONFIG_GLOBAL: devNull,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Sentinel",
      GIT_AUTHOR_EMAIL: "sentinel@skillplane.invalid",
      GIT_COMMITTER_NAME: "Sentinel",
      GIT_COMMITTER_EMAIL: "sentinel@skillplane.invalid",
    },
  })
    .toString()
    .trim();

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("commitDirectory", () => {
  it("commits the given directory even when Git hook variables point at another repository", async () => {
    const sentinel = directory();
    sentinelGit(sentinel, ["init", "-q"]);
    writeFileSync(join(sentinel, "tracked.txt"), "committed\n");
    sentinelGit(sentinel, ["add", "tracked.txt"]);
    sentinelGit(sentinel, ["commit", "-q", "-m", "Sentinel"]);
    writeFileSync(join(sentinel, "staged.txt"), "staged\n");
    sentinelGit(sentinel, ["add", "staged.txt"]);
    const head = sentinelGit(sentinel, ["rev-parse", "HEAD"]);
    const index = readFileSync(join(sentinel, ".git", "index"));

    // A pre-commit or pre-push hook runs with these set for its repository.
    vi.stubEnv("GIT_DIR", join(sentinel, ".git"));
    vi.stubEnv("GIT_WORK_TREE", sentinel);
    vi.stubEnv("GIT_INDEX_FILE", join(sentinel, ".git", "index"));
    vi.resetModules();
    const { commitDirectory } = await import("./git-directory.js");
    const exported = directory();
    writeFileSync(join(exported, "SKILL.md"), "# Exported\n");
    commitDirectory(exported);

    expect(sentinelGit(sentinel, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(sentinel, ".git", "index"))).toEqual(index);
    expect(sentinelGit(exported, ["ls-tree", "-r", "--name-only", "HEAD"])).toBe(
      "SKILL.md",
    );
    expect(sentinelGit(exported, ["log", "--format=%an %s"])).toBe(
      "Skillplane Test Export",
    );
  });
});
