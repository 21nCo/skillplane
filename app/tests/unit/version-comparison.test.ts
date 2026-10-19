import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillVersion, SkillVersionDiff } from "../../src/lib/skills/types.js";

const api = vi.hoisted(() => ({ getSkillDiff: vi.fn() }));

vi.mock("../../src/lib/skills/api.js", () => api);

import {
  VersionComparison,
  defaultComparison,
} from "../../src/lib/skills/version-comparison.svelte.js";

function version(
  id: string,
  revision: number,
  overrides: Partial<SkillVersion> = {},
): SkillVersion {
  return {
    id,
    revision,
    baseVersionId: null,
    status: "published",
    ...overrides,
  } as SkillVersion;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const options = (fromVersionId: string, toVersionId: string) => ({
  workspaceId: "workspace-1",
  skillId: "skill-1",
  fromVersionId,
  toVersionId,
});

describe("defaultComparison", () => {
  it("compares an initial published version forward to the newest later revision", () => {
    const initial = version("v1", 1);
    const versions = [
      version("r3", 3, { status: "pending_review", baseVersionId: "v1" }),
      version("r2", 2, { status: "rejected", baseVersionId: "v1" }),
      initial,
    ];

    expect(defaultComparison(versions, initial)).toEqual({
      fromVersionId: "v1",
      toVersionId: "r3",
    });
  });

  it("compares the current version from its base, else the nearest older revision", () => {
    const current = version("r4", 4, { baseVersionId: "r2" });
    const versions = [version("r5", 5), current, version("r3", 3), version("r2", 2)];

    expect(defaultComparison(versions, current)).toEqual({
      fromVersionId: "r2",
      toVersionId: "r4",
    });
    const unbased = version("r4", 4);
    expect(
      defaultComparison([version("r5", 5), unbased, version("r3", 3)], unbased),
    ).toEqual({ fromVersionId: "r3", toVersionId: "r4" });
    expect(defaultComparison([unbased], unbased)).toBeNull();
  });
});

describe("VersionComparison", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("keeps the latest comparison when an older one completes later", async () => {
    const older = deferred<SkillVersionDiff>();
    const newer = deferred<SkillVersionDiff>();
    api.getSkillDiff
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const comparison = new VersionComparison();

    const first = comparison.compare(options("a", "b"));
    const second = comparison.compare(options("b", "c"));
    newer.resolve({ fromVersionId: "b", toVersionId: "c" } as SkillVersionDiff);
    await second;
    older.resolve({ fromVersionId: "a", toVersionId: "b" } as SkillVersionDiff);
    await first;

    expect(comparison.diff?.fromVersionId).toBe("b");
    expect(comparison.error).toBeNull();
    expect(comparison.loading).toBe(false);
  });

  it("ignores a superseded failure and results that land after a reset", async () => {
    const older = deferred<SkillVersionDiff>();
    const newer = deferred<SkillVersionDiff>();
    api.getSkillDiff
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const comparison = new VersionComparison();

    const first = comparison.compare(options("a", "b"));
    const second = comparison.compare(options("b", "c"));
    older.reject(new Error("Stale failure"));
    await first;
    expect(comparison.error).toBeNull();
    expect(comparison.loading).toBe(true);

    // Another artifact is shown before the newer comparison lands.
    comparison.reset();
    newer.resolve({ fromVersionId: "b", toVersionId: "c" } as SkillVersionDiff);
    await second;
    expect(comparison.diff).toBeNull();
    expect(comparison.loading).toBe(false);
  });
});
