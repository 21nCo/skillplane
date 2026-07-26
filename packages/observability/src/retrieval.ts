import type {
  AuditCallerDeclaration,
  AuditCredential,
  AuditOutcome,
  PostgresAuditWriter,
} from "./audit.js";

export interface RetrievalAuditInput {
  readonly workspaceId: string;
  readonly requestId: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  readonly actorType: "user" | "service_principal";
  readonly actorId: string;
  readonly userId?: string | null;
  readonly credential: AuditCredential;
  readonly caller: AuditCallerDeclaration;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly skillId?: string;
  readonly versionId?: string;
  readonly versionDigest?: string;
  readonly contextId?: string;
  readonly errorCode?: string;
  readonly latencyMs: number;
}

export async function recordRetrievalAudit(
  writer: PostgresAuditWriter,
  input: RetrievalAuditInput,
): Promise<string> {
  return writer.record({
    workspaceId: input.workspaceId,
    eventType: `mcp.${input.tool}.${input.outcome}`,
    action: input.tool,
    outcome: input.outcome,
    actorType: input.actorType,
    actorId: input.actorId,
    requestId: input.requestId,
    credential: input.credential,
    caller: input.caller,
    ...(input.userId !== undefined ? { userId: input.userId } : {}),
    ...(input.resourceType ? { resourceType: input.resourceType } : {}),
    ...(input.resourceId ? { resourceId: input.resourceId } : {}),
    ...(input.skillId ? { skillId: input.skillId } : {}),
    ...(input.versionId ? { versionId: input.versionId } : {}),
    ...(input.versionDigest ? { versionDigest: input.versionDigest } : {}),
    ...(input.contextId ? { contextId: input.contextId } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    latencyMs: input.latencyMs,
    channel: "mcp",
    retentionClass: "detailed_read_90d",
  });
}
