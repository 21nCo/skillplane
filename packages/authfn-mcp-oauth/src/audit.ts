import type { PoolClient } from "pg";
import { redactAuditMetadata, writeAuditEvent } from "@skillplane/observability";
import type { OAuthRuntime } from "./config.js";
import { id } from "./tokens.js";

export interface OAuthAuditInput {
  readonly eventType: string;
  readonly action: string;
  readonly outcome: string;
  readonly userId: string;
  readonly clientId: string;
  readonly requestId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export function oauthRequestId(request: Request): string {
  const value = request.headers.get("x-request-id")?.trim();
  return value && /^[A-Za-z0-9._:-]{1,200}$/.test(value)
    ? value
    : `oauth:${crypto.randomUUID()}`;
}

export async function writeOAuthAudit(
  client: PoolClient,
  runtime: OAuthRuntime,
  input: OAuthAuditInput,
): Promise<void> {
  const workspace = await client.query<{ workspace_id: string }>(
    `SELECT w.id AS workspace_id
       FROM workspace_memberships m
       JOIN workspaces w ON w.id = m.workspace_id
      WHERE m.user_id = $1
      ORDER BY (w.kind = 'personal') DESC, m.created_at, m.id
      LIMIT 1`,
    [input.userId],
  );
  const workspaceId = workspace.rows[0]?.workspace_id;
  if (workspaceId) {
    await writeAuditEvent(client, {
      id: id("audit:", runtime.randomBytes),
      workspaceId,
      eventType: input.eventType,
      action: input.action,
      outcome:
        input.outcome === "success" || input.outcome === "denied"
          ? input.outcome
          : "error",
      actorType: "user",
      actorId: input.userId,
      userId: input.userId,
      requestId: input.requestId,
      resourceType: "oauth_client",
      resourceId: input.clientId,
      channel: "oauth",
      retentionClass: "permanent",
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
  }
  const emittedMetadata = redactAuditMetadata(input.metadata);
  await runtime.emit({
    type: input.eventType,
    requestId: input.requestId,
    outcome: input.outcome,
    actorId: input.userId,
    clientId: input.clientId,
    ...(input.metadata
      ? {
          metadata: {
            ...emittedMetadata.value,
            ...(emittedMetadata.removedFieldCount > 0
              ? {
                  redaction: {
                    removedFieldCount: emittedMetadata.removedFieldCount,
                  },
                }
              : {}),
          },
        }
      : {}),
  });
}

export async function writeOAuthClientDeletionAudit(
  client: PoolClient,
  runtime: OAuthRuntime,
  input: {
    readonly clientId: string;
    readonly requestId: string;
    readonly affectedUserIds: readonly string[];
  },
): Promise<void> {
  const memberships =
    input.affectedUserIds.length > 0
      ? await client.query<{ workspace_id: string }>(
          `SELECT DISTINCT ON (m.user_id) w.id AS workspace_id
             FROM workspace_memberships m
             JOIN workspaces w ON w.id = m.workspace_id
            WHERE m.user_id = ANY($1::text[])
            ORDER BY m.user_id, (w.kind = 'personal') DESC, m.created_at, m.id`,
          [[...new Set(input.affectedUserIds)]],
        )
      : { rows: [] };
  for (const workspaceId of new Set(memberships.rows.map((row) => row.workspace_id))) {
    await writeAuditEvent(client, {
      id: id("audit:", runtime.randomBytes),
      workspaceId,
      eventType: "oauth.client.deleted",
      action: "oauth.client.delete",
      outcome: "success",
      actorType: "system",
      actorId: "system:oauth-client-registry",
      requestId: input.requestId,
      resourceType: "oauth_client",
      resourceId: input.clientId,
      channel: "oauth",
      retentionClass: "permanent",
      metadata: { affectedUserCount: input.affectedUserIds.length },
    });
  }
  await runtime.emit({
    type: "oauth.client.deleted",
    requestId: input.requestId,
    outcome: "success",
    actorId: "system:oauth-client-registry",
    clientId: input.clientId,
    metadata: { affectedUserCount: input.affectedUserIds.length },
  });
}
