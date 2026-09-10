import { writeControlPlaneAuditEvent } from "@skillplane/observability";

interface SqlWriter {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
}

interface ControlPlanePrincipal {
  readonly kind: "user" | "service";
  readonly actorId: string;
  readonly workspaceId: string;
  readonly userId?: string;
  readonly delegatedUserId?: string;
}

export async function writeControlPlaneAudit(
  sql: SqlWriter,
  event: {
    readonly [field: string]: unknown;
    readonly workspaceId?: string | null;
    readonly eventType: string;
    readonly action: string;
    readonly outcome: string;
    readonly actorType: string;
    readonly actorId: string;
    readonly userId?: string | null;
    readonly requestId: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly errorCode?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
    readonly channel?: string;
  },
): Promise<void> {
  await writeControlPlaneAuditEvent(sql, event);
}

export async function writePrincipalControlPlaneAudit(
  sql: SqlWriter,
  principal: ControlPlanePrincipal,
  event: {
    readonly eventType: string;
    readonly action: string;
    readonly requestId: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  return writeControlPlaneAudit(sql, {
    workspaceId: principal.workspaceId,
    eventType: event.eventType,
    action: event.action,
    outcome: "success",
    actorType: principal.kind === "user" ? "user" : "service_principal",
    actorId: principal.actorId,
    userId:
      principal.kind === "user"
        ? (principal.userId ?? principal.actorId)
        : (principal.delegatedUserId ?? null),
    requestId: event.requestId,
    ...(event.resourceType ? { resourceType: event.resourceType } : {}),
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
  });
}
