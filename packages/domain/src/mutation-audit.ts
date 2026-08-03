import type { PoolClient } from "pg";
import { AuditWriteError, writeAuditEvent } from "@skillplane/observability";
import { DomainError } from "./errors.js";
import { principalAuditActor, type Principal } from "./principal.js";

export interface MutationCallerDeclaration {
  readonly agentId: string;
  readonly agentName: string;
  readonly modelProvider: string;
  readonly modelName: string;
  readonly modelVersion: string;
  readonly clientName: string;
  readonly clientVersion: string;
  readonly runId: string;
  readonly sessionId: string;
  readonly conversationId: string;
}

export interface MutationAuditContext {
  readonly channel: "mcp";
  readonly credential: {
    readonly kind: "oauth_access_token" | "service_principal";
    readonly id: string;
    readonly clientId?: string;
  };
  readonly caller: MutationCallerDeclaration;
}

export interface MutationAuditEvent {
  readonly eventType: string;
  readonly action: "skills:amend" | "contexts:write";
  readonly requestId: string;
  readonly resourceType:
    "skill_version" | "context_knowledge_revision" | "context_note_revision";
  readonly resourceId: string;
  readonly contextId?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface PrincipalAuditEvent {
  readonly eventType: string;
  readonly action: string;
  readonly outcome?: "success" | "denied" | "error";
  readonly requestId: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly skillId?: string;
  readonly versionId?: string;
  readonly contextId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

type RetryableAuditError = Error & { readonly code: "40001" | "40P01" };

function isRetryableAuditError(value: unknown): value is RetryableAuditError {
  return (
    value instanceof Error &&
    "code" in value &&
    (value.code === "40001" || value.code === "40P01")
  );
}

function retryableAuditCause(
  error: AuditWriteError,
): RetryableAuditError | undefined {
  let cause: unknown = error.cause;
  while (cause instanceof AuditWriteError) cause = cause.cause;
  return isRetryableAuditError(cause) ? cause : undefined;
}

export function mutationAttribution(audit: MutationAuditContext | undefined): {
  readonly agent: string | null;
  readonly model: string | null;
} {
  return {
    agent: audit?.caller.agentName ?? null,
    model: audit?.caller.modelName ?? null,
  };
}

export async function insertMutationAudit(
  client: PoolClient,
  principal: Principal,
  audit: MutationAuditContext | undefined,
  event: MutationAuditEvent,
): Promise<void> {
  const actor = principalAuditActor(principal);
  try {
    await writeAuditEvent(client, {
      workspaceId: principal.workspaceId,
      eventType: event.eventType,
      action: event.action,
      outcome: "success",
      actorType: actor.actorType,
      actorId: actor.actorId,
      userId:
        principal.kind === "user"
          ? principal.userId
          : (principal.delegatedUserId ?? null),
      requestId: event.requestId,
      resourceType: event.resourceType,
      resourceId: event.resourceId,
      ...(event.contextId ? { contextId: event.contextId } : {}),
      ...(audit
        ? {
            channel: audit.channel,
            credential: audit.credential,
            caller: audit.caller,
            agent: audit.caller.agentName,
            model: audit.caller.modelName,
          }
        : { channel: "app" as const }),
      metadata: event.metadata,
      retentionClass: "permanent",
    });
  } catch (error) {
    if (!(error instanceof AuditWriteError)) throw error;
    const retryable = retryableAuditCause(error);
    if (retryable) throw retryable;
    throw new DomainError(
      "AUDIT_WRITE_FAILED",
      "The mutation audit event could not be recorded",
      503,
    );
  }
}

export async function insertPrincipalAudit(
  client: PoolClient,
  principal: Principal,
  event: PrincipalAuditEvent,
): Promise<void> {
  const actor = principalAuditActor(principal);
  try {
    await writeAuditEvent(client, {
      workspaceId: principal.workspaceId,
      eventType: event.eventType,
      action: event.action,
      outcome: event.outcome ?? "success",
      actorType: actor.actorType,
      actorId: actor.actorId,
      userId:
        principal.kind === "user"
          ? principal.userId
          : (principal.delegatedUserId ?? null),
      requestId: event.requestId,
      ...(event.resourceType ? { resourceType: event.resourceType } : {}),
      ...(event.resourceId ? { resourceId: event.resourceId } : {}),
      ...(event.skillId ? { skillId: event.skillId } : {}),
      ...(event.versionId ? { versionId: event.versionId } : {}),
      ...(event.contextId ? { contextId: event.contextId } : {}),
      channel: "app",
      retentionClass: "permanent",
      ...(event.metadata ? { metadata: event.metadata } : {}),
    });
  } catch (error) {
    if (!(error instanceof AuditWriteError)) throw error;
    const retryable = retryableAuditCause(error);
    if (retryable) throw retryable;
    throw new DomainError(
      "AUDIT_WRITE_FAILED",
      "The audit event could not be recorded",
      503,
    );
  }
}
