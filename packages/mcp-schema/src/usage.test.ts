import { describe, expect, it } from "vitest";
import { skillUsageReportInputSchema } from "./usage.js";
import { randomUUID } from "node:crypto";
const input = {
  skill: { id: "skill:test" },
  versionId: "skill-version:test",
  event: {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: "skill_completion_reported",
    installationId: randomUUID(),
    agent: "codex",
    model: "unknown",
    sessionId: null,
    delivery: "live-cli",
    freshness: "verified",
  },
  caller: {
    agentId: "codex",
    agentName: "codex",
    modelProvider: "unknown",
    modelName: "unknown",
    modelVersion: "unknown",
    clientName: "test",
    clientVersion: "1",
    runId: "run",
    sessionId: "session",
    conversationId: "conversation",
  },
};
describe("usage report trust boundary", () => {
  it("accepts reported activity for an exact authorized version", () => {
    expect(skillUsageReportInputSchema.safeParse(input).success).toBe(true);
  });
  it("rejects verified success, embedded activity totals, and forged confidence", () => {
    expect(
      skillUsageReportInputSchema.safeParse({
        ...input,
        event: { ...input.event, type: "skill_success_verified" },
      }).success,
    ).toBe(false);
    expect(
      skillUsageReportInputSchema.safeParse({
        ...input,
        event: { ...input.event, delivery: "embedded-snapshot" },
      }).success,
    ).toBe(false);
    expect(
      skillUsageReportInputSchema.safeParse({
        ...input,
        event: { ...input.event, confidence: "verified" },
      }).success,
    ).toBe(false);
  });
});
