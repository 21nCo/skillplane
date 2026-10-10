export type AuditOutcome = "success" | "denied" | "error";

export interface AuditEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  readonly principal: {
    readonly actorType: "user" | "service_principal" | "system";
    readonly actorId: string;
    readonly userId: string | null;
    readonly trust: "authenticated";
  };
  readonly credential: Readonly<Record<string, unknown>> | null;
  readonly caller: Readonly<Record<string, unknown>> | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly skillId: string | null;
  readonly versionId: string | null;
  readonly contextId: string | null;
  readonly requestId: string;
  readonly latencyMs: number | null;
  readonly errorCode: string | null;
  readonly retentionClass: "detailed_read_90d" | "permanent";
}

export interface AuditPage {
  readonly events: readonly AuditEvent[];
  readonly nextCursor: string | null;
}

export interface AuditFilterValues {
  readonly from: string;
  readonly to: string;
  readonly outcome?: AuditOutcome;
  readonly tool?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly contextId?: string;
}
