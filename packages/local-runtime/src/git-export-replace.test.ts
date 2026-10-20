import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeBundleFiles,
  serializeWorkspaceRepository,
} from "@skillplane/storage";
import { writeWorkspaceRepository } from "./git-export.js";

// Counts renames and fails chosen ones, so a test can stop a forced export at
// each step after it starts replacing the target's entries.
const renames = vi.hoisted(() => ({ count: 0, fail: new Set<number>() }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      renames.count += 1;
      if (renames.fail.has(renames.count))
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      fs.renameSync(from, to);
    },
  };
});
beforeEach(() => {
  renames.count = 0;
  renames.fail.clear();
});

async function tree(slug: string, text: string) {
  const bundle = await canonicalizeBundleFiles({
    skill: {
      formatVersion: 1,
      entrypoint: "SKILL.md",
      name: slug,
      slug,
      description: "Exported workflow",
      tags: [],
    },
    files: new Map([["SKILL.md", new TextEncoder().encode(text)]]),
  });
  return serializeWorkspaceRepository([
    {
      id: `skill:${slug}`,
      slug,
      visibility: "private",
      semanticVersion: "1.0.0",
      digest: bundle.digest,
      bundle,
    },
  ]);
}

function contents(directory: string, prefix = ""): [string, string][] {
  return readdirSync(join(directory, prefix), { withFileTypes: true })
    .sort((left, right) => (left.name < right.name ? -1 : 1))
    .flatMap((entry) =>
      entry.isDirectory()
        ? contents(directory, `${prefix}${entry.name}/`)
        : [
            [
              `${prefix}${entry.name}`,
              readFileSync(join(directory, prefix, entry.name), "utf8"),
            ] as [string, string],
          ],
    );
}

async function exported() {
  const out = join(
    realpathSync(mkdtempSync(join(tmpdir(), "skillplane-git-replace-"))),
    "clone",
  );
  writeWorkspaceRepository(out, await tree("old", "# Old\n"), false);
  writeFileSync(join(out, "README.md"), "Team skills\n");
  return { out, before: contents(out), next: await tree("new", "# New\n") };
}

describe("forced export replacement", () => {
  it("restores the previous entries when any move fails after replacement begins", async () => {
    const { out, before, next } = await exported();
    // Three managed entries move aside, then three new ones move in.
    for (let step = 1; step <= 6; step += 1) {
      renames.count = 0;
      renames.fail = new Set([step]);
      expect(
        () => writeWorkspaceRepository(out, next, true),
        `step ${String(step)}`,
      ).toThrow(
        expect.objectContaining({
          code: "EXPORT_WRITE_FAILED",
          message: expect.stringContaining("EIO"),
        }),
      );
      expect(contents(out), `step ${String(step)}`).toEqual(before);
    }
    renames.fail.clear();
    writeWorkspaceRepository(out, next, true);
    expect(contents(out).map(([path]) => path)).toEqual([
      ".gitattributes",
      "README.md",
      "skillplane.workspace.json",
      "skills/new/SKILL.md",
      "skills/new/skill.json",
    ]);
  });

  it("keeps the previous entries when they cannot be restored", async () => {
    const { out, next } = await exported();
    // Moving the new skills/ in fails, and so does putting the old manifest back.
    renames.count = 0;
    renames.fail = new Set([6, 10]);
    let error: unknown;
    try {
      writeWorkspaceRepository(out, next, true);
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ code: "EXPORT_RESTORE_FAILED" });
    const previous = /they are in (.+)$/u.exec((error as Error).message)?.[1] ?? "";
    expect(readFileSync(join(previous, "skillplane.workspace.json"), "utf8")).toContain(
      '"slug": "old"',
    );
    expect(existsSync(join(out, "skills", "old", "SKILL.md"))).toBe(true);
  });

  it("replaces read-only skill directories without leaving a staging directory", async () => {
    const { out, next } = await exported();
    mkdirSync(join(out, "skills", "locked"));
    writeFileSync(join(out, "skills", "locked", "SKILL.md"), "# Locked\n");
    chmodSync(join(out, "skills", "locked"), 0o555);
    writeWorkspaceRepository(out, next, true);
    expect(readdirSync(out).sort()).toEqual([
      ".gitattributes",
      "README.md",
      "skillplane.workspace.json",
      "skills",
    ]);
    expect(readdirSync(join(out, "skills"))).toEqual(["new"]);
  });
});
