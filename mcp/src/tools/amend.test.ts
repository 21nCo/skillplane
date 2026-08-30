import type { McpToolRuntime } from "./shared.js";
import type { SkillAmendInput } from "@skillplane/mcp-schema";
import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveSkill = vi.hoisted(() => vi.fn());

vi.mock("./resolve.js", () => ({ resolveSkill }));

import { skillAmend } from "./amend.js";

const caller = {
  agentId: "agent:test",
  agentName: "Codex",
  modelProvider: "OpenAI",
  modelName: "gpt-5.6",
  modelVersion: "2026-08-30",
  clientName: "Skillplane test",
  clientVersion: "1",
  runId: "run:test",
  sessionId: "session:test",
  conversationId: "conversation:test",
} as const;

describe("skillAmend", () => {
  beforeEach(() => {
    resolveSkill.mockReset();
  });

  it("forwards the trusted gateway fencing epoch to auto-publication", async () => {
    const principal = {
      kind: "service",
      actorId: "service:test",
      servicePrincipalId: "service:test",
      userId: null,
      workspaceId: "workspace:test",
      role: "admin",
      scopes: ["skills:amend"],
    } as const;
    resolveSkill.mockImplementation(async (_runtime, execution) => {
      execution.setScope({
        workspaceId: "workspace:test",
        resourceType: "skill",
        resourceId: "skill:test",
        skillId: "skill:test",
      });
      return { id: "skill:test", principal };
    });
    const amend = vi.fn(async () => ({
      candidate: {
        id: "skill-version:candidate",
        revision: 2,
        semanticVersion: "1.0.1",
        digest: `sha256:${"a".repeat(64)}`,
        createdAt: "2026-08-30T00:00:00.000Z",
        publishedAt: "2026-08-30T00:00:00.000Z",
      },
      review: { id: "review:test", status: "approved" },
      policyDecision: {
        outcome: "auto_publish",
        reason: "trusted_rule_matched",
        matchedRule: 0,
      },
      autoPublished: true,
    }));
    const audit = {
      record: vi.fn(async () => undefined),
      recordBatch: vi.fn(async () => undefined),
    };
    const runtime = {
      services: { amendmentService: { amend } },
      identity: {
        kind: "service",
        actorType: "service_principal",
        actorId: "service:test",
        servicePrincipalId: "service:test",
        userId: null,
        credentialId: "credential:test",
        credentialKind: "service_principal",
        workspaceId: "workspace:test",
        displayName: "Test service",
        role: "admin",
        scopes: ["skills:amend"],
      },
      audit,
      fencingEpoch: 9,
      now: () => new Date("2026-08-30T00:00:00.000Z"),
    } as unknown as McpToolRuntime;
    const input = {
      skillId: "skill:test",
      baseVersionId: "skill-version:base",
      idempotencyKey: "amend-test-epoch",
      proposedBump: "patch",
      changes: [
        {
          operation: "replace",
          path: "SKILL.md",
          expectedSha256: "b".repeat(64),
          content: "# Updated",
          contentBase64: null,
        },
      ],
      learning: {},
      caller,
    } as unknown as SkillAmendInput;

    await skillAmend(runtime, input);

    expect(amend).toHaveBeenCalledWith(expect.objectContaining({ fencingEpoch: 9 }));
  });
});
