import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import type { CallerDeclaration } from "@skillplane/mcp-schema";
import { ControlPlaneMcpAuditWriter, type McpAuditRecord } from "./audit.js";

const caller: CallerDeclaration = {
  agentId: "agent:test",
  agentName: "Audit test agent",
  modelProvider: "test",
  modelName: "test-model",
  modelVersion: "1",
  clientName: "test-client",
  clientVersion: "1",
  runId: "run:test",
  sessionId: "session:test",
  conversationId: "conversation:test",
};

function record(overrides: Partial<McpAuditRecord> = {}): McpAuditRecord {
  return {
    workspaceId: "workspace:test",
    requestId: "request:test",
    tool: "workspaces_list",
    outcome: "success",
    identity: {
      kind: "oauth",
      actorType: "user",
      actorId: "user:test",
      userId: "user:test",
      credentialKind: "oauth_access_token",
      credentialId: "token:test",
      clientId: "client:test",
      scopes: ["skills:read"],
      expiresAt: new Date("2026-08-31T00:00:00.000Z"),
    },
    caller,
    resourceType: "workspace",
    resourceId: "workspace:test",
    contextId: "context:test",
    latencyMs: 12.34,
    ...overrides,
  };
}

describe("ControlPlaneMcpAuditWriter", () => {
  it("writes global MCP audit batches to the control-plane audit table", async () => {
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => ({
      rows: [],
      rowCount: 1,
    }));
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    await new ControlPlaneMcpAuditWriter(pool).recordBatch([
      record(),
      record({ workspaceId: "workspace:second", resourceId: "workspace:second" }),
    ]);

    expect(query.mock.calls[0]?.[0]).toBe("BEGIN");
    expect(query.mock.calls[1]?.[0]).toContain(
      "INSERT INTO control_plane_audit_events",
    );
    expect(query.mock.calls[2]?.[0]).toContain(
      "INSERT INTO control_plane_audit_events",
    );
    expect(query.mock.calls[3]?.[0]).toBe("COMMIT");
    expect(
      query.mock.calls.some(([sql]) =>
        String(sql).includes("INSERT INTO audit_events"),
      ),
    ).toBe(false);
    expect(release).toHaveBeenCalledOnce();
  });

  it("rolls back and fails closed when the control audit insert fails", async () => {
    let queryCount = 0;
    const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
      queryCount += 1;
      if (queryCount === 2) throw new Error("control audit unavailable");
      return { rows: [], rowCount: null };
    });
    const release = vi.fn();
    const pool = {
      connect: vi.fn(async () => ({ query, release })),
    } as unknown as Pool;

    await expect(
      new ControlPlaneMcpAuditWriter(pool).record(record()),
    ).rejects.toMatchObject({ code: "AUDIT_WRITE_FAILED" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(release).toHaveBeenCalledOnce();
  });
});
