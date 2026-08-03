import type { CallerDeclaration } from "@skillplane/mcp-schema";
import { McpToolError, type McpErrorCode } from "@skillplane/mcp-schema";
import {
  AuditWriteError,
  PostgresAuditWriter,
  writeAuditEvent,
  type AuditWriteInput,
} from "@skillplane/observability";
import type { Pool } from "pg";
import type { McpIdentity } from "./auth.js";

export interface McpAuditRecord {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly tool: string;
  readonly outcome: "success" | "denied" | "error";
  readonly identity: McpIdentity;
  readonly caller: CallerDeclaration;
  readonly resourceType?: "workspace" | "skill" | "skill_version" | "context";
  readonly resourceId?: string;
  readonly skillId?: string;
  readonly versionId?: string;
  readonly versionDigest?: string;
  readonly contextId?: string;
  readonly errorCode?: McpErrorCode;
  readonly latencyMs: number;
  readonly countMetric?: boolean;
}

export interface McpAuditWriter {
  record(event: McpAuditRecord): Promise<void>;
  recordBatch(events: readonly McpAuditRecord[]): Promise<void>;
}

export async function persistMcpAudit(
  writer: McpAuditWriter,
  event: McpAuditRecord,
): Promise<void> {
  try {
    await writer.record(event);
  } catch {
    throw new McpToolError(
      "AUDIT_WRITE_FAILED",
      "The access event could not be recorded",
      { status: 503, retryable: true },
    );
  }
}

export async function persistMcpAuditBatch(
  writer: McpAuditWriter,
  events: readonly McpAuditRecord[],
): Promise<void> {
  try {
    await writer.recordBatch(events);
  } catch {
    throw new McpToolError(
      "AUDIT_WRITE_FAILED",
      "The access event could not be recorded",
      { status: 503, retryable: true },
    );
  }
}

function auditInput(event: McpAuditRecord): AuditWriteInput {
  const mutation = [
    "skill_amend",
    "context_create",
    "context_update",
    "context_archive",
    "context_restore",
    "context_knowledge_update",
    "context_note_upsert",
  ].includes(event.tool);
  return {
    workspaceId: event.workspaceId,
    eventType: `mcp.${event.tool}.${event.outcome}`,
    action: event.tool,
    outcome: event.outcome,
    actorType: event.identity.actorType,
    actorId: event.identity.actorId,
    userId: event.identity.userId,
    requestId: event.requestId,
    agent: event.caller.agentName,
    model: event.caller.modelName,
    caller: event.caller,
    credential: {
      kind: event.identity.credentialKind,
      id: event.identity.credentialId,
      ...(event.identity.kind === "oauth" ? { clientId: event.identity.clientId } : {}),
    },
    channel: "mcp",
    retentionClass: mutation ? "permanent" : "detailed_read_90d",
    ...(event.resourceType ? { resourceType: event.resourceType } : {}),
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
    ...(event.skillId ? { skillId: event.skillId } : {}),
    ...(event.versionId ? { versionId: event.versionId } : {}),
    ...(event.versionDigest ? { versionDigest: event.versionDigest } : {}),
    ...(event.contextId ? { contextId: event.contextId } : {}),
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    latencyMs: event.latencyMs,
  };
}

export class PostgresMcpAuditWriter implements McpAuditWriter {
  readonly #writer: PostgresAuditWriter;

  constructor(private readonly pool: Pool) {
    this.#writer = new PostgresAuditWriter(pool);
  }

  async record(event: McpAuditRecord): Promise<void> {
    try {
      await this.#writer.record(auditInput(event));
    } catch (error) {
      if (!(error instanceof AuditWriteError)) throw error;
      throw new McpToolError(
        "AUDIT_WRITE_FAILED",
        "The access event could not be recorded",
        { status: 503, retryable: true },
      );
    }
  }

  async recordBatch(events: readonly McpAuditRecord[]): Promise<void> {
    if (events.length === 0) return;
    const client = await this.pool.connect().catch(() => null);
    if (!client) {
      throw new McpToolError(
        "AUDIT_WRITE_FAILED",
        "The access event could not be recorded",
        { status: 503, retryable: true },
      );
    }
    try {
      await client.query("BEGIN");
      for (const event of events) {
        await writeAuditEvent(client, auditInput(event));
      }
      await client.query("COMMIT");
    } catch {
      await client.query("ROLLBACK").catch(() => undefined);
      throw new McpToolError(
        "AUDIT_WRITE_FAILED",
        "The access event could not be recorded",
        { status: 503, retryable: true },
      );
    } finally {
      client.release();
    }
  }
}

export function emitMcpOperationalEvent(event: {
  readonly requestId: string;
  readonly tool: string;
  readonly outcome: "success" | "denied" | "error";
  readonly errorCode?: McpErrorCode;
  readonly actorType: McpIdentity["actorType"];
  readonly actorId: string;
  readonly resourceId?: string;
  readonly latencyMs: number;
}): void {
  console.info(
    JSON.stringify({
      component: "mcp",
      requestId: event.requestId,
      tool: event.tool,
      outcome: event.outcome,
      ...(event.errorCode ? { errorCode: event.errorCode } : {}),
      actorType: event.actorType,
      actorId: event.actorId,
      ...(event.resourceId ? { resourceId: event.resourceId } : {}),
      durationMs: Math.max(0, Math.round(event.latencyMs * 10) / 10),
    }),
  );
}
