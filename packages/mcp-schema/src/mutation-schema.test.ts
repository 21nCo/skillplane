import { describe, expect, it } from "vitest";
import {
  contextCreateInputSchema,
  contextKnowledgeHistoryInputSchema,
  contextKnowledgeUpdateInputSchema,
  contextStateMutationInputSchema,
  contextNoteUpsertInputSchema,
  contextsListInputSchema,
  contextUpdateInputSchema,
  skillAmendInputSchema,
  skillAmendmentPolicyUpdateInputSchema,
  skillCandidateDecisionInputSchema,
  skillCandidatesListInputSchema,
  skillCreateInputSchema,
  skillStateMutationInputSchema,
  skillVersionsDiffInputSchema,
  skillVisibilityUpdateInputSchema,
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
  it("supports discovery, creation, metadata concurrency, lifecycle, and history", () => {
    expect(
      contextsListInputSchema.parse({
        skill: { id: "skill:review" },
        caller,
      }),
    ).toMatchObject({ state: "active", cursor: null, limit: 20 });
    expect(
      contextCreateInputSchema.parse({
        skill: { id: "skill:review" },
        slug: "repository-main",
        name: "Repository main",
        type: "repository",
        initialKnowledge: "# Repository\n\nUse pnpm validation.",
        idempotencyKey: "context-create-run-123",
        caller,
      }),
    ).toMatchObject({
      externalReference: null,
      description: "",
      metadata: {},
      learningMetadata: {},
    });
    expect(
      contextUpdateInputSchema.parse({
        skill: { id: "skill:review" },
        context: { slug: "repository-main" },
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        patch: { description: "Main repository context" },
        idempotencyKey: "context-update-run-123",
        caller,
      }).patch,
    ).toEqual({ description: "Main repository context" });
    expect(
      contextStateMutationInputSchema.parse({
        skill: { id: "skill:review" },
        context: { id: "context:repo" },
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        idempotencyKey: "context-archive-run-123",
        caller,
      }).expectedUpdatedAt,
    ).toBe("2026-08-03T12:00:00.000Z");
    expect(
      contextKnowledgeHistoryInputSchema.parse({
        skill: { id: "skill:review" },
        context: { id: "context:repo" },
        caller,
      }),
    ).toMatchObject({ cursor: null, limit: 20 });
  });

  it("rejects empty metadata patches and missing concurrency tokens", () => {
    expect(
      contextUpdateInputSchema.safeParse({
        skill: { id: "skill:review" },
        context: { id: "context:repo" },
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        patch: {},
        idempotencyKey: "context-update-run-123",
        caller,
      }).success,
    ).toBe(false);
    expect(
      contextStateMutationInputSchema.safeParse({
        skill: { id: "skill:review" },
        context: { id: "context:repo" },
        idempotencyKey: "context-archive-run-123",
        caller,
      }).success,
    ).toBe(false);
  });

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

describe("MCP skill lifecycle schemas", () => {
  it("accepts bounded creation, lifecycle, review, policy, and diff inputs", () => {
    expect(
      skillCreateInputSchema.parse({
        workspace: { id: "workspace:owner" },
        slug: "production-review",
        name: "Production review",
        instructions: "# Production review\n\nInspect the live system.",
        assets: [
          { path: "references/checklist.md", content: "# Checklist" },
          { path: "assets/icon.bin", contentBase64: "AAEC/w==" },
        ],
        idempotencyKey: "skill-create-run-123",
        caller,
      }),
    ).toMatchObject({
      description: "",
      tags: [],
      visibility: "private",
    });
    expect(
      skillVisibilityUpdateInputSchema.parse({
        skill: { id: "skill:review" },
        visibility: "workspace",
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        idempotencyKey: "skill-visibility-run-123",
        caller,
      }).visibility,
    ).toBe("workspace");
    expect(
      skillStateMutationInputSchema.parse({
        skill: { id: "skill:review" },
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        idempotencyKey: "skill-archive-run-123",
        caller,
      }).expectedUpdatedAt,
    ).toBe("2026-08-03T12:00:00.000Z");
    expect(
      skillCandidatesListInputSchema.parse({
        skill: { id: "skill:review" },
        caller,
      }),
    ).toMatchObject({ status: "all", cursor: null, limit: 20 });
    expect(
      skillCandidateDecisionInputSchema.parse({
        skill: { id: "skill:review" },
        reviewId: "amendment-review:one",
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        reason: "Validated against production",
        idempotencyKey: "candidate-approve-run-123",
        caller,
      }).reason,
    ).toBe("Validated against production");
    expect(
      skillAmendmentPolicyUpdateInputSchema.parse({
        skill: { id: "skill:review" },
        expectedUpdatedAt: "2026-08-03T12:00:00.000Z",
        policy: { mode: "review_required" },
        idempotencyKey: "policy-run-123",
        caller,
      }).policy,
    ).toEqual({ mode: "review_required" });
    expect(
      skillVersionsDiffInputSchema.parse({
        skill: { id: "skill:review" },
        fromVersionId: "skill-version:one",
        toVersionId: "skill-version:two",
        caller,
      }).toVersionId,
    ).toBe("skill-version:two");
  });

  it("rejects reserved files, ambiguous encodings, and missing concurrency tokens", () => {
    const base = {
      workspace: { id: "workspace:owner" },
      slug: "production-review",
      name: "Production review",
      instructions: "# Production review",
      idempotencyKey: "skill-create-run-123",
      caller,
    };
    expect(
      skillCreateInputSchema.safeParse({
        ...base,
        assets: [{ path: "SKILL.md", content: "override" }],
      }).success,
    ).toBe(false);
    expect(
      skillCreateInputSchema.safeParse({
        ...base,
        assets: [
          {
            path: "references/one.md",
            content: "one",
            contentBase64: "b25l",
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      skillCreateInputSchema.safeParse({
        ...base,
        assets: [
          { path: "references/one.md", content: "one" },
          { path: "references/one.md", content: "two" },
        ],
      }).success,
    ).toBe(false);
    expect(
      skillStateMutationInputSchema.safeParse({
        skill: { id: "skill:review" },
        idempotencyKey: "skill-archive-run-123",
        caller,
      }).success,
    ).toBe(false);
  });
});
