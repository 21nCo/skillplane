import type { CallerDeclaration } from "@skillplane/mcp-schema";
import { McpToolError, type McpErrorCode } from "@skillplane/mcp-schema";
import {
  auditMetadata,
  AuditWriteError,
  PostgresAuditWriter,
  writeAuditEvent,
  writeControlPlaneAuditEvent,
  type AuditWriteInput,
  type ControlPlaneAuditWriteInput,
} from "@skillplane/observability";
import { enqueueAgentSkillUseProjection } from "@skillplane/domain";
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
  readonly fencingEpoch?: number;
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
    fencingEpoch: event.fencingEpoch,
  };
}

function controlPlaneAuditInput(event: McpAuditRecord): ControlPlaneAuditWriteInput {
  const input = auditInput(event);
  return {
    workspaceId: input.workspaceId,
    eventType: input.eventType,
    action: input.action,
    outcome: input.outcome,
    actorType: input.actorType,
    actorId: input.actorId,
    requestId: input.requestId,
    channel: "mcp",
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    metadata: {
      ...auditMetadata(input),
      ...(event.contextId ? { contextId: event.contextId } : {}),
    },
  };
}

export class ControlPlaneMcpAuditWriter implements McpAuditWriter {
  constructor(private readonly pool: Pool) {}

  async record(event: McpAuditRecord): Promise<void> {
    await this.recordBatch([event]);
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
        await writeControlPlaneAuditEvent(client, controlPlaneAuditInput(event));
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

export class PostgresMcpAuditWriter implements McpAuditWriter {
  readonly #writer: PostgresAuditWriter;

  constructor(
    private readonly pool: Pool,
    private readonly projectionEnabled = false,
  ) {
    this.#writer = new PostgresAuditWriter(pool);
  }

  async record(event: McpAuditRecord): Promise<void> {
    const countUse =
      this.projectionEnabled &&
      event.tool === "skill_retrieve" &&
      event.outcome === "success" &&
      event.countMetric !== false;
    try {
      if (!countUse) {
        await this.#writer.record(auditInput(event));
        return;
      }
      const client = await this.pool.connect().catch((error: unknown) => {
        throw new AuditWriteError(error);
      });
      try {
        await client.query("BEGIN");
        if (event.fencingEpoch !== undefined) {
          await client.query(
            "SELECT set_config('skillplane.workspace_routing_epoch', $1, true)",
            [String(event.fencingEpoch)],
          );
        }
        await writeAuditEvent(client, auditInput(event));
        await enqueueAgentSkillUseProjection(client, {
          workspaceId: event.workspaceId,
          fencingEpoch: event.fencingEpoch,
        });
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error instanceof AuditWriteError ? error : new AuditWriteError(error);
      } finally {
        client.release();
      }
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
        if (event.fencingEpoch !== undefined) {
          await client.query(
            "SELECT set_config('skillplane.workspace_routing_epoch', $1, true)",
            [String(event.fencingEpoch)],
          );
        }
        await writeAuditEvent(client, auditInput(event));
        if (
          this.projectionEnabled &&
          event.tool === "skill_retrieve" &&
          event.outcome === "success" &&
          event.countMetric !== false
        ) {
          await enqueueAgentSkillUseProjection(client, {
            workspaceId: event.workspaceId,
            fencingEpoch: event.fencingEpoch,
          });
        }
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
