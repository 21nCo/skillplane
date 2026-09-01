import type { Pool, PoolClient, QueryResultRow } from "pg";
import { redactAuditMetadata } from "./redaction.js";

export type AuditOutcome = "success" | "denied" | "error";
export type AuditRetentionClass = "detailed_read_90d" | "permanent";
export type AuditActorType = "user" | "service_principal" | "system";

export interface AuditCallerDeclaration {
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

export interface AuditCredential {
  readonly kind: string;
  readonly id: string;
  readonly clientId?: string;
}

export interface AuditWriteInput {
  readonly workspaceId: string;
  readonly eventType: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actorType: AuditActorType;
  readonly actorId: string;
  readonly userId?: string | null;
  readonly requestId: string;
  readonly resourceType?: string;
  readonly resourceId?: string;
  readonly skillId?: string;
  readonly versionId?: string;
  readonly versionDigest?: string;
  readonly contextId?: string;
  readonly agent?: string;
  readonly model?: string;
  readonly caller?: AuditCallerDeclaration;
  readonly credential?: AuditCredential;
  readonly latencyMs?: number;
  readonly errorCode?: string;
  readonly channel?: "app" | "mcp" | "oauth" | "system";
  readonly retentionClass?: AuditRetentionClass;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly occurredAt?: Date;
  readonly id?: string;
  readonly fencingEpoch?: number | undefined;
}

export interface ControlPlaneAuditWriteInput {
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
  readonly id?: string;
}

export interface AuditQueryable {
  query(
    text: string,
    values?: readonly unknown[],
  ): Promise<{
    readonly rows: readonly QueryResultRow[];
    readonly rowCount: number | null;
  }>;
}

export class AuditWriteError extends Error {
  constructor(cause?: unknown) {
    super("The audit event could not be recorded", { cause });
    this.name = "AuditWriteError";
  }
}

function boundedLatency(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.round(value * 10) / 10);
}

export function auditMetadata(
  input: AuditWriteInput,
): Readonly<Record<string, unknown>> {
  const combined = {
    channel: input.channel ?? "app",
    ...(input.credential ? { credential: input.credential } : {}),
    ...(input.caller
      ? {
          caller: {
            ...input.caller,
            trust: "caller-declared",
          },
        }
      : {}),
    ...(input.skillId ? { skillId: input.skillId } : {}),
    ...(input.versionId ? { versionId: input.versionId } : {}),
    ...(input.versionDigest ? { versionDigest: input.versionDigest } : {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
    ...(boundedLatency(input.latencyMs) !== undefined
      ? { latencyMs: boundedLatency(input.latencyMs) }
      : {}),
    ...(input.metadata ?? {}),
  };
  const redacted = redactAuditMetadata(combined);
  return {
    ...redacted.value,
    ...(redacted.removedFieldCount > 0
      ? { redaction: { removedFieldCount: redacted.removedFieldCount } }
      : {}),
  };
}

export async function writeAuditEvent(
  queryable: AuditQueryable,
  input: AuditWriteInput,
): Promise<string> {
  const id = input.id ?? `audit:${crypto.randomUUID()}`;
  try {
    await queryable.query(
      `INSERT INTO audit_events
         (id, workspace_id, occurred_at, event_type, action, outcome,
          actor_type, actor_id, user_id, agent, model, request_id,
          resource_type, resource_id, context_id, metadata, retention_class)
       VALUES (
         $1, $2, COALESCE($3, now()), $4, $5, $6, $7, $8, $9, $10, $11,
         $12, $13, $14, $15, $16, $17
       )`,
      [
        id,
        input.workspaceId,
        input.occurredAt ?? null,
        input.eventType,
        input.action,
        input.outcome,
        input.actorType,
        input.actorId,
        input.userId ?? null,
        input.agent ?? input.caller?.agentName ?? null,
        input.model ?? input.caller?.modelName ?? null,
        input.requestId,
        input.resourceType ?? null,
        input.resourceId ?? null,
        input.contextId ?? null,
        auditMetadata(input),
        input.retentionClass ?? "permanent",
      ],
    );
    return id;
  } catch (error) {
    throw new AuditWriteError(error);
  }
}

/** Writes global identity, tenancy, and routing decisions to the control authority. */
export async function writeControlPlaneAuditEvent(
  queryable: { query(text: string, values?: readonly unknown[]): Promise<unknown> },
  input: ControlPlaneAuditWriteInput,
): Promise<string> {
  const id = input.id ?? `control-audit:${crypto.randomUUID()}`;
  const redacted = redactAuditMetadata({
    ...(input.metadata ?? {}),
    ...(input.errorCode ? { errorCode: input.errorCode } : {}),
  });
  await queryable.query(
    `INSERT INTO control_plane_audit_events
       (id, workspace_id, event_type, action, outcome, actor_type, actor_id,
        user_id, request_id, resource_type, resource_id, metadata, channel)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
    [
      id,
      input.workspaceId ?? null,
      input.eventType,
      input.action,
      input.outcome,
      input.actorType,
      input.actorId,
      input.userId ?? null,
      input.requestId,
      input.resourceType ?? null,
      input.resourceId ?? null,
      JSON.stringify({
        ...redacted.value,
        ...(redacted.removedFieldCount > 0
          ? { redaction: { removedFieldCount: redacted.removedFieldCount } }
          : {}),
      }),
      input.channel ?? "app",
    ],
  );
  return id;
}

export class PostgresAuditWriter {
  constructor(private readonly pool: Pool) {}

  async record(input: AuditWriteInput): Promise<string> {
    const client = await this.pool.connect().catch(() => null);
    if (!client) throw new AuditWriteError();
    try {
      await client.query("BEGIN");
      if (input.fencingEpoch !== undefined) {
        await client.query(
          "SELECT set_config('skillplane.workspace_routing_epoch', $1, true)",
          [String(input.fencingEpoch)],
        );
      }
      const id = await writeAuditEvent(client, input);
      await client.query("COMMIT");
      return id;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error instanceof AuditWriteError ? error : new AuditWriteError(error);
    } finally {
      client.release();
    }
  }
}

export function auditClient(client: PoolClient): AuditQueryable {
  return client;
}

export interface AuditFilters {
  readonly from: Date;
  readonly to: Date;
  readonly skillId?: string;
  readonly contextId?: string;
  readonly tool?: string;
  readonly outcome?: AuditOutcome;
  readonly agent?: string;
  readonly model?: string;
}

export interface AuditEventView {
  readonly id: string;
  readonly occurredAt: string;
  readonly eventType: string;
  readonly tool: string;
  readonly outcome: AuditOutcome;
  readonly principal: {
    readonly actorType: AuditActorType;
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
  readonly retentionClass: AuditRetentionClass;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface AuditPage {
  readonly events: readonly AuditEventView[];
  readonly nextCursor: string | null;
}

interface AuditRow {
  readonly id: string;
  readonly occurred_at: Date;
  readonly event_type: string;
  readonly action: string;
  readonly outcome: AuditOutcome;
  readonly actor_type: AuditActorType;
  readonly actor_id: string;
  readonly user_id: string | null;
  readonly request_id: string;
  readonly resource_type: string | null;
  readonly resource_id: string | null;
  readonly context_id: string | null;
  readonly metadata: Record<string, unknown>;
  readonly retention_class: AuditRetentionClass;
}

interface CursorPayload {
  readonly workspaceId: string;
  readonly occurredAt: string;
  readonly id: string;
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  const encoded = new TextEncoder().encode(value);
  return new Uint8Array(
    encoded.buffer.slice(encoded.byteOffset, encoded.byteOffset + encoded.byteLength),
  );
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(`${normalized}${padding}`);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8(value))));
}

async function encodeCursor(secret: string, payload: CursorPayload): Promise<string> {
  const body = base64Url(utf8(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

async function decodeCursor(
  secret: string,
  value: string,
  workspaceId: string,
): Promise<CursorPayload> {
  const [body, signature, extra] = value.split(".");
  if (!body || !signature || extra || (await hmac(secret, body)) !== signature) {
    throw new Error("Audit cursor is invalid");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(body)));
  } catch {
    throw new Error("Audit cursor is invalid");
  }
  if (
    !payload ||
    typeof payload !== "object" ||
    (payload as CursorPayload).workspaceId !== workspaceId ||
    typeof (payload as CursorPayload).occurredAt !== "string" ||
    !Number.isFinite(new Date((payload as CursorPayload).occurredAt).getTime()) ||
    typeof (payload as CursorPayload).id !== "string"
  ) {
    throw new Error("Audit cursor is invalid");
  }
  return payload as CursorPayload;
}

function metadataObject(
  value: unknown,
  key: string,
): Readonly<Record<string, unknown>> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return nested && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as Readonly<Record<string, unknown>>)
    : null;
}

function metadataString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "string" ? nested : null;
}

function metadataNumber(value: unknown, key: string): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>)[key];
  return typeof nested === "number" && Number.isFinite(nested) ? nested : null;
}

function auditView(row: AuditRow): AuditEventView {
  const redacted = redactAuditMetadata(row.metadata);
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    eventType: row.event_type,
    tool: row.action,
    outcome: row.outcome,
    principal: {
      actorType: row.actor_type,
      actorId: row.actor_id,
      userId: row.user_id,
      trust: "authenticated",
    },
    credential: metadataObject(redacted.value, "credential"),
    caller: metadataObject(redacted.value, "caller"),
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    skillId: metadataString(redacted.value, "skillId"),
    versionId: metadataString(redacted.value, "versionId"),
    contextId: row.context_id,
    requestId: row.request_id,
    latencyMs: metadataNumber(redacted.value, "latencyMs"),
    errorCode: metadataString(redacted.value, "errorCode"),
    retentionClass: row.retention_class,
    metadata: {
      ...redacted.value,
      ...(redacted.removedFieldCount > 0
        ? { redaction: { removedFieldCount: redacted.removedFieldCount } }
        : {}),
    },
  };
}

function auditWhere(
  workspaceId: string,
  filters: AuditFilters,
  cursor?: CursorPayload,
  source: "regional" | "control" = "regional",
): { readonly sql: string; readonly values: unknown[] } {
  const clauses = ["workspace_id = $1", "occurred_at >= $2", "occurred_at < $3"];
  const values: unknown[] = [workspaceId, filters.from, filters.to];
  const add = (clause: (position: number) => string, value: unknown) => {
    values.push(value);
    clauses.push(clause(values.length));
  };
  if (filters.skillId) {
    add(
      (position) =>
        `(metadata->>'skillId' = $${String(position)} OR (resource_type = 'skill' AND resource_id = $${String(position)}))`,
      filters.skillId,
    );
  }
  if (filters.contextId) {
    add(
      (position) =>
        source === "regional"
          ? `context_id = $${String(position)}`
          : `metadata->>'contextId' = $${String(position)}`,
      filters.contextId,
    );
  }
  if (filters.tool) {
    add((position) => `action = $${String(position)}`, filters.tool);
  }
  if (filters.outcome) {
    add((position) => `outcome = $${String(position)}`, filters.outcome);
  }
  if (filters.agent) {
    add(
      (position) =>
        source === "regional"
          ? `agent = $${String(position)}`
          : `(metadata->>'agent' = $${String(position)} OR metadata->'caller'->>'agentName' = $${String(position)})`,
      filters.agent,
    );
  }
  if (filters.model) {
    add(
      (position) =>
        source === "regional"
          ? `model = $${String(position)}`
          : `(metadata->>'model' = $${String(position)} OR metadata->'caller'->>'modelName' = $${String(position)})`,
      filters.model,
    );
  }
  if (cursor) {
    values.push(cursor.occurredAt, cursor.id);
    clauses.push(
      `(occurred_at, id) < ($${String(values.length - 1)}, $${String(values.length)})`,
    );
  }
  return { sql: clauses.join(" AND "), values };
}

function compareAuditRows(left: AuditRow, right: AuditRow): number {
  const time = right.occurred_at.getTime() - left.occurred_at.getTime();
  if (time !== 0) return time;
  return left.id === right.id ? 0 : left.id < right.id ? 1 : -1;
}

async function readAuditRows(
  pool: Pool,
  source: "regional" | "control",
  options: {
    readonly workspaceId: string;
    readonly filters: AuditFilters;
    readonly cursor?: CursorPayload;
    readonly limit: number;
  },
): Promise<readonly AuditRow[]> {
  const where = auditWhere(
    options.workspaceId,
    options.filters,
    options.cursor,
    source,
  );
  const selection =
    source === "regional"
      ? `SELECT id, occurred_at, event_type, action, outcome, actor_type, actor_id,
                user_id, request_id, resource_type, resource_id, context_id,
                metadata, retention_class
           FROM audit_events`
      : `SELECT id, occurred_at, event_type, action, outcome, actor_type, actor_id,
                user_id, request_id, resource_type, resource_id,
                COALESCE(metadata->>'contextId', metadata->>'context_id') AS context_id,
                metadata || jsonb_build_object('channel', channel) AS metadata,
                'permanent'::text AS retention_class
           FROM control_plane_audit_events`;
  const result = await pool.query<AuditRow>(
    `${selection}
      WHERE ${where.sql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${String(where.values.length + 1)}`,
    [...where.values, options.limit],
  );
  return result.rows;
}

export async function readAuditEvents(
  pool: Pool,
  options: {
    readonly workspaceId: string;
    readonly filters: AuditFilters;
    readonly cursorSecret: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly controlPool?: Pool;
  },
): Promise<AuditPage> {
  const cursor = options.cursor
    ? await decodeCursor(options.cursorSecret, options.cursor, options.workspaceId)
    : undefined;
  const limit = Math.min(100, Math.max(1, Math.floor(options.limit ?? 50)));
  const rows = (
    await Promise.all([
      readAuditRows(pool, "regional", {
        workspaceId: options.workspaceId,
        filters: options.filters,
        ...(cursor ? { cursor } : {}),
        limit: limit + 1,
      }),
      ...(options.controlPool
        ? [
            readAuditRows(options.controlPool, "control", {
              workspaceId: options.workspaceId,
              filters: options.filters,
              ...(cursor ? { cursor } : {}),
              limit: limit + 1,
            }),
          ]
        : []),
    ])
  )
    .flat()
    .sort(compareAuditRows);
  const hasMore = rows.length > limit;
  const pageRows = rows.slice(0, limit);
  const last = pageRows.at(-1);
  return {
    events: pageRows.map(auditView),
    nextCursor:
      hasMore && last
        ? await encodeCursor(options.cursorSecret, {
            workspaceId: options.workspaceId,
            occurredAt: last.occurred_at.toISOString(),
            id: last.id,
          })
        : null,
  };
}

function csvValue(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ""
      : typeof value === "string"
        ? value
        : JSON.stringify(value);
  return `"${text.replaceAll('"', '""')}"`;
}

export async function exportAuditEventsCsv(
  pool: Pool,
  options: {
    readonly workspaceId: string;
    readonly filters: AuditFilters;
    readonly limit?: number;
    readonly controlPool?: Pool;
  },
): Promise<string> {
  const limit = Math.min(10_000, Math.max(1, Math.floor(options.limit ?? 5_000)));
  const rows = (
    await Promise.all([
      readAuditRows(pool, "regional", {
        workspaceId: options.workspaceId,
        filters: options.filters,
        limit,
      }),
      ...(options.controlPool
        ? [
            readAuditRows(options.controlPool, "control", {
              workspaceId: options.workspaceId,
              filters: options.filters,
              limit,
            }),
          ]
        : []),
    ])
  )
    .flat()
    .sort(compareAuditRows)
    .slice(0, limit);
  const header = [
    "occurred_at",
    "event_type",
    "tool",
    "outcome",
    "authenticated_actor_type",
    "authenticated_actor_id",
    "authenticated_user_id",
    "credential",
    "declared_caller",
    "resource_type",
    "resource_id",
    "skill_id",
    "version_id",
    "context_id",
    "request_id",
    "latency_ms",
    "error_code",
    "retention_class",
  ];
  const lines = rows.map((row) => {
    const event = auditView(row);
    return [
      event.occurredAt,
      event.eventType,
      event.tool,
      event.outcome,
      event.principal.actorType,
      event.principal.actorId,
      event.principal.userId,
      event.credential,
      event.caller,
      event.resourceType,
      event.resourceId,
      event.skillId,
      event.versionId,
      event.contextId,
      event.requestId,
      event.latencyMs,
      event.errorCode,
      event.retentionClass,
    ]
      .map(csvValue)
      .join(",");
  });
  return `\uFEFF${header.map(csvValue).join(",")}\r\n${lines.join("\r\n")}\r\n`;
}
