import { describe, expect, it } from "vitest";
import {
  normalizeContextName,
  normalizeContextSlug,
  normalizeExternalReference,
  normalizeKnowledge,
  normalizeMetadata,
  parseContextArchiveFilter,
  parseContextType,
  sha256TextDigest,
} from "./contexts.js";
import {
  normalizeNoteBody,
  normalizeNoteTitle,
  parseNoteArchiveFilter,
} from "./context-notes.js";

describe("context contracts", () => {
  it("accepts every context type and lifecycle filter", () => {
    for (const type of ["repository", "project", "customer", "environment", "custom"]) {
      expect(parseContextType(type)).toBe(type);
    }
    expect(parseContextArchiveFilter("active")).toBe("active");
    expect(parseContextArchiveFilter("archived")).toBe("archived");
    expect(parseContextArchiveFilter("all")).toBe("all");
    expect(parseNoteArchiveFilter("all")).toBe("all");
  });

  it("normalizes bounded context and note fields without changing Markdown source", () => {
    expect(normalizeContextSlug(" btnextjs ")).toBe("btnextjs");
    expect(normalizeContextName(" btnextjs ")).toBe("btnextjs");
    expect(normalizeExternalReference(" repo:btnextjs ")).toBe("repo:btnextjs");
    const knowledge = "# Notes\r\n\r\nPreserve exact source.  \n";
    expect(normalizeKnowledge(knowledge)).toBe(knowledge);
    expect(normalizeNoteTitle(" Review threads ")).toBe("Review threads");
    expect(normalizeNoteBody(knowledge)).toBe(knowledge);
  });

  it("creates stable SHA-256 body digests", async () => {
    await expect(sha256TextDigest("hello")).resolves.toBe(
      "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("rejects invalid slugs, types, and empty documents", () => {
    expect(() => normalizeContextSlug("Bad Slug")).toThrow(/lowercase/u);
    expect(() => parseContextType("account")).toThrow(/Context type/u);
    expect(() => normalizeKnowledge("  ")).toThrow(/contain Markdown/u);
    expect(() => normalizeNoteBody("")).toThrow(/contain Markdown/u);
  });

  it("enforces knowledge and note byte limits before persistence", () => {
    expect(() => normalizeKnowledge("x".repeat(512 * 1024 + 1))).toThrow(/512 KiB/u);
    expect(() => normalizeNoteBody("x".repeat(256 * 1024 + 1))).toThrow(/256 KiB/u);
  });

  it("accepts bounded JSON metadata and rejects unsafe depth or key counts", () => {
    expect(
      normalizeMetadata({ summary: "Observed behavior", confidence: 0.9 }),
    ).toEqual({
      summary: "Observed behavior",
      confidence: 0.9,
    });
    let nested: Record<string, unknown> = {};
    for (let depth = 0; depth < 10; depth += 1) nested = { nested };
    expect(() => normalizeMetadata(nested)).toThrow(/8 levels/u);
    expect(() =>
      normalizeMetadata(
        Object.fromEntries(
          Array.from({ length: 201 }, (_, index) => [`key-${index}`, index]),
        ),
      ),
    ).toThrow(/200 keys/u);
  });
});
