import { expect, it, vi } from "vitest";
import { McpToolError } from "@skillplane/mcp-schema";
import { executeMutationTool, executeReadTool, type McpToolRuntime } from "./shared.js";
import type { McpAuditRecord } from "../audit.js";

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

for (const [kind, execute] of [
  ["mutation", executeMutationTool],
  ["read", executeReadTool],
] as const) {
  for (const [code, status] of [
    ["WORKSPACE_FORBIDDEN", 403],
    ["SKILL_VERSION_CONFLICT", 409],
  ] as const) {
    it(`preserves ${kind} ${code} while auditing a moved workspace`, async () => {
      const record = vi.fn(async (event: McpAuditRecord) => {
        if (event.fencingEpoch !== 9) throw new Error("stale routing epoch");
      });
      const runtime = {
        fencingEpoch: 9,
        identity: { actorType: "service_principal", actorId: "service:test" },
        audit: { record, recordBatch: async () => undefined },
      } as unknown as McpToolRuntime;
      const response = await execute(
        runtime,
        "skill_amend",
        caller,
        async (execution) => {
          execution.setScope({ workspaceId: "workspace:moved" });
          throw new McpToolError(code, "Expected failure", { status });
        },
      );
      expect(response.isError).toBe(true);
      const content = response.content[0];
      if (content?.type !== "text") throw new Error("Expected error response");
      expect(JSON.parse(content.text).error.code).toBe(code);
      expect(record).toHaveBeenCalledWith(
        expect.objectContaining({
          workspaceId: "workspace:moved",
          fencingEpoch: 9,
          errorCode: code,
          outcome: status === 403 ? "denied" : "error",
        }),
      );
    });
  }
}
