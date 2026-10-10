import { sha256Hex } from "@skillplane/storage";
import { describe, expect, it } from "vitest";
import {
  applyAmendmentOperations,
  parseAmendmentOperations,
  parseCallerDeclaration,
} from "./amendments.js";
import { DomainError } from "./errors.js";
import type { UserPrincipal } from "./principal.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const principal: UserPrincipal = {
  kind: "user",
  actorId: "user:editor",
  userId: "user:editor",
  sessionId: "session:one",
  workspaceId: "workspace:one",
  role: "editor",
};

describe("deterministic amendment operations", () => {
  it("applies add, replace, and delete with expected digests", async () => {
    const originalSkill = encoder.encode("# Review\n\nOld.\n");
    const originalReference = encoder.encode("Remove me");
    const operations = parseAmendmentOperations([
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: await sha256Hex(originalSkill),
        content: "# Review\n\nNew.\n",
      },
      {
        operation: "delete",
        path: "references/old.md",
        expectedSha256: await sha256Hex(originalReference),
      },
      {
        operation: "add",
        path: "references/new.md",
        expectedSha256: null,
        content: "New evidence",
      },
    ]);
    const result = await applyAmendmentOperations(
      new Map([
        ["SKILL.md", originalSkill],
        ["references/old.md", originalReference],
      ]),
      operations,
    );
    expect(decoder.decode(result.get("SKILL.md"))).toContain("New.");
    expect(result.has("references/old.md")).toBe(false);
    expect(decoder.decode(result.get("references/new.md"))).toBe("New evidence");
  });

  it("returns SKILL_VERSION_CONFLICT for an incorrect file digest", async () => {
    const operations = parseAmendmentOperations([
      {
        operation: "replace",
        path: "SKILL.md",
        expectedSha256: "0".repeat(64),
        content: "# Changed",
      },
    ]);
    await expect(
      applyAmendmentOperations(
        new Map([["SKILL.md", encoder.encode("# Original")]]),
        operations,
      ),
    ).rejects.toMatchObject({ code: "SKILL_VERSION_CONFLICT" });
  });

  it("rejects generated metadata, duplicate paths, and unexpected operation fields", () => {
    for (const changes of [
      [
        {
          operation: "delete",
          path: "skill.json",
          expectedSha256: "0".repeat(64),
        },
      ],
      [
        {
          operation: "add",
          path: "references/A.md",
          expectedSha256: null,
          content: "A",
        },
        {
          operation: "add",
          path: "references/a.md",
          expectedSha256: null,
          content: "B",
        },
      ],
      [
        {
          operation: "add",
          path: "references/a.md",
          expectedSha256: null,
          content: "A",
          userId: "user:attacker",
        },
      ],
    ]) {
      expect(() => parseAmendmentOperations(changes)).toThrow(DomainError);
    }
  });

  it("keeps authenticated and declared identities separate", () => {
    expect(
      parseCallerDeclaration(
        {
          agent: "codex",
          model: "gpt-5",
          client: "mcp",
          runId: "run:123",
        },
        principal,
      ),
    ).toMatchObject({
      agent: "codex",
      model: "gpt-5",
      forUserId: principal.userId,
    });
    expect(() =>
      parseCallerDeclaration(
        {
          agent: "codex",
          model: "gpt-5",
          client: "mcp",
          runId: "run:123",
          forUserId: "user:other",
        },
        principal,
      ),
    ).toThrowError(/cannot replace the authenticated user/u);
    expect(() =>
      parseCallerDeclaration(
        {
          agent: "codex",
          model: "gpt-5",
          client: "mcp",
          runId: "run:123",
          userId: "user:other",
        },
        principal,
      ),
    ).toThrowError(/not supported/u);
  });
});
