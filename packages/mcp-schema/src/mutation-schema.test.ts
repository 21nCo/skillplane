import { describe, expect, it } from "vitest";
import {
  contextKnowledgeUpdateInputSchema,
  contextNoteUpsertInputSchema,
  skillAmendInputSchema,
} from "./index.js";

const caller = {
  agentId: "agent_instance_123",
  agentName: "Codex",
  modelProvider: "OpenAI",
  modelName: "gpt-5",
  modelVersion: "2026-07-01",
  clientName: "Codex Desktop",
  clientVersion: "1.0.0",
  runId: "run_123",
  sessionId: "session_123",
  conversationId: "conversation_123",
} as const;

const learning = {
  summary: "Clarify live review-thread handling",
  observation: "Live review threads changed the result.",
  rationale: "Agents must inspect the authoritative review source.",
  confidence: "high" as const,
  evidence: [
    {
      kind: "run",
      reference: "run_123",
      description: "The live-thread check found unresolved feedback.",
    },
  ],
  validation: [
    {
      kind: "manual",
      status: "passed" as const,
      description: "Replayed against two repositories.",
    },
  ],
};

describe("MCP amendment schemas", () => {
  it("accepts exact add, replace, and delete operations with complete provenance", () => {
    const parsed = skillAmendInputSchema.parse({
      skillId: "skill:review",
      baseVersionId: "skill-version:7",
      idempotencyKey: "amend-run_123-attempt_1",
      changes: [
        {
          operation: "add",
          path: "references/new.md",
          expectedSha256: null,
          content: "New",
        },
        {
          operation: "replace",
          path: "SKILL.md",
          expectedSha256: "a".repeat(64),
          content: "# Updated skill",
        },
        {
          operation: "delete",
          path: "references/old.md",
          expectedSha256: "b".repeat(64),
        },
      ],
      learning,
      caller,
    });
    expect(parsed.proposedBump).toBe("patch");
    expect(parsed.learning).toMatchObject({
      evidenceUnavailableReason: null,
      validationNotRunReason: null,
      sourceContextId: null,
      tags: [],
      extra: {},
    });
  });

  it("rejects ambiguous content, missing learning evidence, and caller-selected users", () => {
    const base = {
      skillId: "skill:review",
      baseVersionId: "skill-version:7",
      idempotencyKey: "amend-1",
      changes: [
        {
          operation: "replace",
          path: "SKILL.md",
          expectedSha256: "a".repeat(64),
          content: "# One",
          contentBase64: "IyBUd28=",
        },
      ],
      learning: { ...learning, evidence: [] },
      caller: { ...caller, userId: "user:other" },
    };
    expect(skillAmendInputSchema.safeParse(base).success).toBe(false);
  });
});

describe("MCP context mutation schemas", () => {
  it("bounds context knowledge and note mutations with replay keys", () => {
    expect(
      contextKnowledgeUpdateInputSchema.parse({
        skill: { id: "skill:review" },
        context: { id: "context:repo" },
        expectedRevision: 3,
        markdown: "Inspect live review threads.",
        learningMetadata: { source: "run:123" },
        idempotencyKey: "knowledge-run-123",
        caller,
      }),
    ).toMatchObject({ expectedRevision: 3 });
    expect(
      contextNoteUpsertInputSchema.parse({
        skill: { id: "skill:review" },
        context: { slug: "repository-main" },
        title: "Review thread API",
        markdown: "Use the server-side review API.",
        idempotencyKey: "note-run-123",
        caller,
      }),
    ).toMatchObject({ noteId: null, expectedRevision: null });
  });

  it("rejects missing caller fields and invalid revision or idempotency bounds", () => {
    expect(
      contextNoteUpsertInputSchema.safeParse({
        skill: { id: "skill:review" },
        context: { id: "context:repo" },
        noteId: "context-note:one",
        expectedRevision: 0,
        title: "Review thread API",
        markdown: "Use the server-side review API.",
        idempotencyKey: "contains spaces",
        caller: { ...caller, modelVersion: undefined },
      }).success,
    ).toBe(false);
  });
});
