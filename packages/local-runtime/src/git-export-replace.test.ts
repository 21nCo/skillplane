import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type * as NodeFs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  canonicalizeBundleFiles,
  serializeWorkspaceRepository,
} from "@skillplane/storage";
import { writeWorkspaceRepository } from "./git-export.js";

// Counts renames, fails chosen ones and runs a callback before chosen ones, so
// a test can stop an export, or start a competing one, at each step after it
// starts replacing the target's entries.
const renames = vi.hoisted(() => ({
  count: 0,
  fail: new Set<number>(),
  before: new Map<number, () => void>(),
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof NodeFs>();
  return {
    ...fs,
    renameSync: (from: string, to: string) => {
      renames.count += 1;
      renames.before.get(renames.count)?.();
      if (renames.fail.has(renames.count))
        throw Object.assign(new Error("injected rename failure"), { code: "EIO" });
      fs.renameSync(from, to);
    },
  };
});
beforeEach(() => {
  renames.count = 0;
  renames.fail.clear();
  renames.before.clear();
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
    const previous =
      /they are in (.+?)\. Move/u.exec((error as Error).message)?.[1] ?? "";
    expect(readFileSync(join(previous, "skillplane.workspace.json"), "utf8")).toContain(
      '"slug": "old"',
    );
    expect(existsSync(join(out, "skills", "old", "SKILL.md"))).toBe(true);
    // The kept entries also keep the target closed to later exports.
    expect(() => writeWorkspaceRepository(out, next, true)).toThrow(
      expect.objectContaining({ code: "EXPORT_BUSY" }),
    );
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

describe("export target ownership", () => {
  // Runs a competing export while the first one is part way through and
  // returns its error, checking that it changed nothing.
  const compete = (out: string, next: ReadonlyMap<string, Uint8Array>) => {
    const errors: unknown[] = [];
    return {
      errors,
      run: () => {
        for (const force of [false, true]) {
          const before = contents(out);
          renames.before.clear();
          try {
            writeWorkspaceRepository(out, next, force);
          } catch (error) {
            errors.push(error);
          }
          expect(contents(out)).toEqual(before);
        }
      },
    };
  };
  const busy = expect.objectContaining({
    code: "EXPORT_BUSY",
    message: expect.stringContaining(".skillplane-export"),
  });

  it("refuses a competing export while an unforced export installs into an empty target", async () => {
    const out = join(
      realpathSync(mkdtempSync(join(tmpdir(), "skillplane-git-owner-"))),
      "clone",
    );
    const first = await tree("first", "# First\n"),
      second = await tree("second", "# Second\n");
    const competing = compete(out, second);
    // The first rename installs .gitattributes; nothing was there to move aside.
    renames.before.set(1, competing.run);
    writeWorkspaceRepository(out, first, false);
    expect(competing.errors).toEqual([busy, busy]);
    expect(contents(out).map(([path]) => path)).toEqual([
      ".gitattributes",
      "skillplane.workspace.json",
      "skills/first/SKILL.md",
      "skills/first/skill.json",
    ]);
    expect(readFileSync(join(out, "skills", "first", "SKILL.md"), "utf8")).toBe(
      "# First\n",
    );
  });

  it("refuses a competing export while a forced export fails and restores the target", async () => {
    const { out, before, next } = await exported();
    const competing = compete(out, await tree("other", "# Other\n"));
    // Steps 1-3 move the old entries aside; step 4 installs the first new one
    // and step 6, installing skills/, fails.
    renames.before.set(5, competing.run);
    renames.fail = new Set([6]);
    expect(() => writeWorkspaceRepository(out, next, true)).toThrow(
      expect.objectContaining({ code: "EXPORT_WRITE_FAILED" }),
    );
    expect(competing.errors).toEqual([busy, busy]);
    expect(contents(out)).toEqual(before);
  });

  it("refuses to export over the work directory of an interrupted export", async () => {
    const { out, before, next } = await exported();
    const work = join(out, ".skillplane-export");
    mkdirSync(join(work, "previous", "skills", "kept"), { recursive: true });
    writeFileSync(join(work, "previous", "skills", "kept", "SKILL.md"), "# Kept\n");
    const leftover = contents(out);
    for (const force of [false, true]) {
      expect(() => writeWorkspaceRepository(out, next, force)).toThrow(
        expect.objectContaining({
          code: "EXPORT_BUSY",
          message: expect.stringContaining(join(work, "previous")),
        }),
      );
      expect(contents(out)).toEqual(leftover);
    }
    rmSync(work, { recursive: true });
    expect(contents(out)).toEqual(before);
    writeWorkspaceRepository(out, next, true);
    expect(existsSync(join(out, "skills", "new", "SKILL.md"))).toBe(true);
  });

  it("removes a target it created when the export fails", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "skillplane-git-create-")));
    const out = join(base, "nested", "clone");
    const next = await tree("new", "# New\n");
    renames.fail = new Set([1]);
    expect(() => writeWorkspaceRepository(out, next, false)).toThrow(
      expect.objectContaining({ code: "EXPORT_WRITE_FAILED" }),
    );
    expect(readdirSync(base)).toEqual([]);
    // An existing empty target is kept.
    mkdirSync(out, { recursive: true });
    renames.count = 0;
    expect(() => writeWorkspaceRepository(out, next, false)).toThrow(
      expect.objectContaining({ code: "EXPORT_WRITE_FAILED" }),
    );
    expect(readdirSync(dirname(out))).toEqual(["clone"]);
    expect(readdirSync(out)).toEqual([]);
  });
});
