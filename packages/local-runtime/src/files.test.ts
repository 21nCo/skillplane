import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Lets a test act as a concurrent process between safeDirectory's existence
// check and its mkdir.
const race = vi.hoisted(() => ({
  path: undefined as string | undefined,
  act: undefined as ((path: string) => void) | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof fs>();
  return {
    ...actual,
    existsSync: (path: fs.PathLike) => {
      const exists = actual.existsSync(path);
      if (!exists && path === race.path) race.act?.(String(path));
      return exists;
    },
  };
});
const { safeDirectory } = await import("./files.js");

const roots: string[] = [];
afterEach(() => {
  race.path = race.act = undefined;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const root = () => {
  const path = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "skillplane-files-")));
  roots.push(path);
  return path;
};

describe("safeDirectory", () => {
  it("accepts a directory another process creates after the existence check", () => {
    const base = root();
    const target = join(base, "a", "b");
    race.path = join(base, "a");
    race.act = (path) => fs.mkdirSync(path, { mode: 0o700 });
    expect(safeDirectory(target)).toBe(target);
    expect(fs.lstatSync(target).isDirectory()).toBe(true);
  });

  it("still rejects a symlink planted in the same window and a dangling symlink", () => {
    const base = root();
    race.path = join(base, "planted");
    race.act = (path) => fs.symlinkSync(join(base, "elsewhere"), path);
    expect(() => safeDirectory(join(base, "planted", "child"))).toThrow(
      "SYMLINK_FORBIDDEN",
    );
    race.path = race.act = undefined;
    fs.symlinkSync(join(base, "nowhere"), join(base, "dangling"));
    expect(() => safeDirectory(join(base, "dangling", "child"))).toThrow(
      "SYMLINK_FORBIDDEN",
    );
    expect(fs.existsSync(join(base, "nowhere"))).toBe(false);
  });
});
