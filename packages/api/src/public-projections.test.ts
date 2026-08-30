import { describe, expect, it } from "vitest";
import { BundleValidationError, StorageError } from "@skillplane/storage";
import {
  mapPublicProjectionFileError,
  PublicSkillProjectionService,
} from "./public-projections.js";

const row = (id: string, score: string) => ({
  workspace_id: "workspace:one",
  workspace_slug: "one",
  skill_id: id,
  skill_slug: id.replace("skill:", ""),
  version_id: `version:${id}`,
  semantic_version: "1.0.0",
  digest: `sha256:${"a".repeat(64)}`,
  object_key: `public/${id}.zip`,
  document: {
    skill: { name: id, description: "description", tags: ["search"] },
    version: { revision: 1, publishedAt: "2026-08-01T00:00:00.000Z" },
  },
  published_at: new Date("2026-08-29T00:00:00.000Z"),
  score,
});

describe("global public projection search", () => {
  it("uses relevance keyset pagination and binds cursors to filters", async () => {
    const calls: { text: string; values: readonly unknown[] }[] = [];
    const pool = {
      async query(text: string, values: readonly unknown[]) {
        calls.push({ text, values });
        return calls.length === 1
          ? {
              rows: [
                row("skill:a", "900"),
                row("skill:b", "800"),
                row("skill:c", "700"),
              ],
            }
          : { rows: [] };
      },
    };
    const service = new PublicSkillProjectionService(
      pool as never,
      {} as never,
      "public-projection-cursor-secret-000000000000",
    );
    const first = await service.discover({
      query: "search",
      tags: ["search"],
      limit: 2,
    });
    expect(first.skills.map((skill) => skill.id)).toEqual(["skill:a", "skill:b"]);
    expect(first.skills.map((skill) => skill.score)).toEqual(["900", "800"]);
    expect(first.nextCursor).toBeTruthy();
    expect(calls[0]?.text).toContain("ORDER BY score DESC, skill_id ASC");

    await service.discover({
      query: "search",
      tags: ["search"],
      limit: 2,
      cursor: first.nextCursor,
    });
    expect(calls[1]?.values.slice(2, 4)).toEqual(["800", "skill:b"]);

    await expect(
      service.discover({
        query: "different",
        tags: ["search"],
        limit: 2,
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "CURSOR_FILTER_MISMATCH" });
  });

  it("retrieves a public skill by its stable ID", async () => {
    const calls: string[] = [];
    const pool = {
      async query(text: string) {
        calls.push(text);
        return { rows: [row("skill:public", "0")] };
      },
    };
    const service = new PublicSkillProjectionService(
      pool as never,
      {} as never,
      "public-projection-cursor-secret-000000000000",
    );
    const current = await service.getCurrentBySkillId("skill:public");
    expect(current.skill.id).toBe("skill:public");
    expect(current.skill.visibility).toBe("public");
    expect(current.version.publishedAt).toBe("2026-08-01T00:00:00.000Z");
    expect(calls[0]).toContain(
      "version_id = document->'skill'->>'currentPublishedVersionId'",
    );
  });

  it("applies the domain search bounds before querying the global projection", async () => {
    const pool = { query: async () => ({ rows: [] }) };
    const service = new PublicSkillProjectionService(
      pool as never,
      {} as never,
      "public-projection-cursor-secret-000000000000",
    );

    await expect(
      service.discover({ query: "x".repeat(501), tags: [] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    await expect(
      service.discover({
        query: "valid",
        tags: Array.from({ length: 31 }, (_, index) => `tag-${index}`),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
    await expect(
      service.discover({ query: "valid", tags: ["invalid tag"] }),
    ).rejects.toMatchObject({ code: "VALIDATION_FAILED", status: 400 });
  });

  it("uses the declared current version and revision ordering for tied timestamps", async () => {
    const calls: string[] = [];
    const pool = {
      async query(text: string) {
        calls.push(text);
        return { rows: [row("skill:tied", "0")] };
      },
    };
    const service = new PublicSkillProjectionService(
      pool as never,
      {} as never,
      "public-projection-cursor-secret-000000000000",
    );

    await service.getCurrent("one", "tied");
    await service.listVersions("one", "tied");

    expect(calls[0]).toContain(
      "version_id = document->'skill'->>'currentPublishedVersionId'",
    );
    expect(calls[1]).toContain(
      "(document->'version'->>'revision')::bigint DESC NULLS LAST",
    );
  });

  it("keeps public bundle storage and integrity failures retryable", async () => {
    expect(() =>
      mapPublicProjectionFileError(
        new StorageError("R2_READ_FAILED", "Bundle object could not be read"),
      ),
    ).toThrowError(expect.objectContaining({ code: "R2_READ_FAILED", status: 503 }));
    expect(() =>
      mapPublicProjectionFileError(
        new BundleValidationError("SKILL_BUNDLE_INVALID", "Invalid archive"),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "R2_OBJECT_MISMATCH", status: 503 }),
    );
    expect(() =>
      mapPublicProjectionFileError(new Error("SKILL_FILE_NOT_FOUND")),
    ).toThrowError(
      expect.objectContaining({ code: "SKILL_FILE_NOT_FOUND", status: 404 }),
    );
  });
});
