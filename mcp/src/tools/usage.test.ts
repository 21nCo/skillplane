import { describe, expect, it, vi, beforeEach } from "vitest";
import type { McpToolRuntime } from "./shared.js";
import { skillUsageReportInputSchema } from "@skillplane/mcp-schema";
const mocks = vi.hoisted(() => ({
  resolveSkill: vi.fn(),
  resolveVersion: vi.fn(),
  principalForWorkspace: vi.fn(),
  claim: vi.fn(),
  complete: vi.fn(),
  release: vi.fn(),
  insert: vi.fn(),
  transaction: vi.fn(),
}));
vi.mock("./resolve.js", () => ({
  resolveSkill: mocks.resolveSkill,
  resolveVersion: mocks.resolveVersion,
}));
vi.mock("../auth.js", () => ({ principalForWorkspace: mocks.principalForWorkspace }));
vi.mock("@skillplane/domain", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  IdempotencyStore: class {
    claim = mocks.claim;
    complete = mocks.complete;
    release = mocks.release;
  },
  insertPrincipalAudit: mocks.insert,
  withDomainTransaction: mocks.transaction,
}));
import { skillUsageReport } from "./usage.js";
const input = skillUsageReportInputSchema.parse({
  skill: { id: "skill:test" },
  versionId: "skill-version:test",
  event: {
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    type: "skill_completion_reported",
    installationId: crypto.randomUUID(),
    agent: "codex",
    model: "declared",
    sessionId: null,
    delivery: "cached-cli",
    freshness: "unverified",
  },
  caller: {
    agentId: "codex",
    agentName: "codex",
    modelProvider: "unknown",
    modelName: "declared",
    modelVersion: "unknown",
    clientName: "test",
    clientVersion: "1",
    runId: "run",
    sessionId: "session",
    conversationId: "conversation",
  },
});
const runtime = {
  services: { skillService: { pool: {} } },
  identity: {
    kind: "service",
    actorType: "service_principal",
    actorId: "service:test",
    servicePrincipalId: "service:test",
    userId: null,
    credentialId: "credential:test",
    credentialKind: "service_principal",
    workspaceId: "workspace:test",
    role: "viewer",
    scopes: ["skills:read"],
  },
  audit: {
    record: vi.fn(async () => undefined),
    recordBatch: vi.fn(async () => undefined),
  },
  fencingEpoch: 7,
  now: () => new Date(),
} as unknown as McpToolRuntime;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSkill.mockImplementation(async (_runtime, execution) => {
    execution.setScope({ workspaceId: "workspace:test", skillId: "skill:test" });
    return { id: "skill:test", workspaceId: "workspace:test" };
  });
  mocks.resolveVersion.mockResolvedValue({ id: "skill-version:test" });
  mocks.principalForWorkspace.mockResolvedValue({
    kind: "service",
    actorId: "service:test",
    workspaceId: "workspace:test",
  });
  mocks.claim.mockResolvedValue({
    state: "claimed",
    identity: { key: input.event.id },
  });
  mocks.transaction.mockImplementation(async (_pool, _id, fn) => fn({ client: {} }));
});
describe("cloud usage ingestion", () => {
  it("authorizes exact version, fences the write and stores caller claims as reported", async () => {
    const result = await skillUsageReport(runtime, input);
    expect(result.isError).not.toBe(true);
    expect(mocks.resolveVersion).toHaveBeenCalledWith(
      runtime,
      expect.anything(),
      expect.anything(),
      { selector: "versionId", versionId: input.versionId },
    );
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        metadata: {
          usage: expect.objectContaining({
            confidence: "reported",
            modelTrust: "caller-declared",
            delivery: "cached-cli",
          }),
        },
      }),
    );
    expect(mocks.transaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { fencingEpoch: 7 },
    );
  });
  it("does not double-count a replay", async () => {
    mocks.claim.mockResolvedValue({ state: "replay" });
    await skillUsageReport(runtime, input);
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("denies cross-workspace access before claiming an event receipt", async () => {
    mocks.resolveSkill.mockRejectedValue(new Error("WORKSPACE_FORBIDDEN"));
    const result = await skillUsageReport(runtime, input);
    expect(result.isError).toBe(true);
    expect(mocks.claim).not.toHaveBeenCalled();
  });
});
