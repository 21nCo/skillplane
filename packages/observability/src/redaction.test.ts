import { describe, expect, it } from "vitest";
import { containsSensitiveAuditData, redactAuditMetadata } from "./redaction.js";
import { auditMetadata } from "./audit.js";

describe("audit redaction", () => {
  it("removes prompt, skill body, OTP, email, token, secret, and nested values", () => {
    const result = redactAuditMetadata({
      prompt: "Review the repository",
      nested: {
        skillBody: "# Secret instructions",
        otp: "123456",
        email: "person@example.test",
        accessToken: "secret",
        allowed: "skill:review",
      },
      authorization: "Bearer not-persisted",
      credentials: ["sps_legacycredentialvalue", "spk_authfnapikeycredentialvalue"],
      safe: ["model:gpt", { contextId: "context:one" }],
    });

    expect(result.value).toEqual({
      credentials: [],
      nested: { allowed: "skill:review" },
      safe: ["model:gpt", { contextId: "context:one" }],
    });
    expect(result.removedFieldCount).toBe(8);
    expect(JSON.stringify(result.value)).not.toContain("example.test");
    expect(containsSensitiveAuditData({ note: "person@example.test" })).toBe(true);
  });

  it("keeps controlled caller fields and labels them as caller-declared", () => {
    const metadata = auditMetadata({
      workspaceId: "workspace:one",
      eventType: "mcp.skill_retrieve.success",
      action: "skill_retrieve",
      outcome: "success",
      actorType: "service_principal",
      actorId: "service:one",
      requestId: "request:one",
      caller: {
        agentId: "agent:codex",
        agentName: "Codex",
        modelProvider: "openai",
        modelName: "gpt",
        modelVersion: "5",
        clientName: "zed",
        clientVersion: "1",
        runId: "run:one",
        sessionId: "session:one",
        conversationId: "conversation:one",
      },
      skillId: "skill:one",
      latencyMs: 12.345,
    });

    expect(metadata).toMatchObject({
      skillId: "skill:one",
      latencyMs: 12.3,
      caller: {
        agentName: "Codex",
        modelName: "gpt",
        trust: "caller-declared",
      },
    });
  });
});
