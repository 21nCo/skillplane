import { describe, expect, it } from "vitest";
import {
  callerAudit,
  callerDeclarationSchema,
  contextGetInputSchema,
  contextNotesListInputSchema,
  mcpErrorSchema,
  skillAssetRetrieveInputSchema,
  skillRetrieveInputSchema,
  skillsSearchInputSchema,
  skillVersionsListInputSchema,
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

describe("MCP caller declaration", () => {
  it("requires, trims, and preserves the complete declared caller", () => {
    const parsed = callerDeclarationSchema.parse({
      ...caller,
      agentName: "  Codex  ",
    });
    expect(parsed).toEqual(caller);
    expect(callerAudit(parsed)).toEqual({
      ...caller,
      trust: "caller-declared",
    });
  });

  it.each([
    "agentId",
    "agentName",
    "modelProvider",
    "modelName",
    "modelVersion",
    "clientName",
    "clientVersion",
    "runId",
    "sessionId",
    "conversationId",
  ] as const)("rejects a missing %s", (field) => {
    const input = Object.fromEntries(
      Object.entries(caller).filter(([key]) => key !== field),
    );
    expect(callerDeclarationSchema.safeParse(input).success).toBe(false);
  });

  it("rejects caller-selected user identity and control characters", () => {
    expect(
      callerDeclarationSchema.safeParse({
        ...caller,
        userId: "user:someone-else",
      }).success,
    ).toBe(false);
    expect(
      callerDeclarationSchema.safeParse({
        ...caller,
        agentName: "Codex\nspoofed",
      }).success,
    ).toBe(false);
  });
});

describe("MCP read schemas", () => {
  it("applies bounded search defaults", () => {
    expect(
      skillsSearchInputSchema.parse({
        query: "pull request review",
        workspaceId: "workspace:acme",
        caller,
      }),
    ).toMatchObject({
      visibility: ["private", "workspace", "public"],
      tags: [],
      cursor: null,
      limit: 20,
    });
    expect(
      skillsSearchInputSchema.safeParse({
        query: "review",
        workspaceId: "workspace:acme",
        limit: 101,
        caller,
      }).success,
    ).toBe(false);
  });

  it("requires unambiguous skill and version selectors", () => {
    expect(
      skillRetrieveInputSchema.parse({
        skill: {
          workspaceSlug: "acme",
          skillSlug: "pr-review",
        },
        caller,
      }),
    ).toMatchObject({ version: { selector: "current" } });
    expect(
      skillRetrieveInputSchema.safeParse({
        skill: {
          id: "skill:one",
          workspaceSlug: "acme",
          skillSlug: "pr-review",
        },
        caller,
      }).success,
    ).toBe(false);
    expect(
      skillAssetRetrieveInputSchema.safeParse({
        skill: { id: "skill:one" },
        version: {
          selector: "versionId",
          versionId: "skill-version:one",
          revision: 1,
        },
        path: "references/checklist.md",
        caller,
      }).success,
    ).toBe(false);
  });

  it("normalizes version, context, and note-list defaults", () => {
    expect(
      skillVersionsListInputSchema.parse({
        skill: { id: "skill:one" },
        caller,
      }),
    ).toMatchObject({
      states: ["published"],
      cursor: null,
      limit: 20,
    });
    expect(
      contextGetInputSchema.parse({
        skill: { id: "skill:one" },
        context: { slug: "project-alpha" },
        caller,
      }),
    ).toMatchObject({
      knowledge: { selector: "current" },
      includeNotes: true,
    });
    expect(
      contextNotesListInputSchema.parse({
        skill: { id: "skill:one" },
        context: { id: "context:one" },
        caller,
      }),
    ).toMatchObject({ state: "active", cursor: null, limit: 20 });
  });

  it("validates the stable machine-readable error envelope", () => {
    expect(
      mcpErrorSchema.parse({
        ok: false,
        error: {
          code: "AUDIT_WRITE_FAILED",
          message: "The access event could not be recorded",
          retryable: true,
          requestId: "mcp:req",
        },
      }),
    ).toMatchObject({
      error: { code: "AUDIT_WRITE_FAILED", retryable: true },
    });
    expect(
      mcpErrorSchema.safeParse({
        ok: false,
        error: {
          code: "SQL_FAILURE",
          message: "unsafe",
          retryable: true,
          requestId: "mcp:req",
        },
      }).success,
    ).toBe(false);
  });
});
