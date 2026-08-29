import {
  DomainError,
  WorkspaceAccessError,
  authorize,
  type Principal,
  type SkillVersionRecord,
} from "@skillplane/domain";
import type { Context } from "hono";
import type { PoolClient } from "pg";
import { writeAuditEvent } from "@skillplane/observability";
import type { ApiEnvironment } from "../context.js";
import { requireUserPrincipal } from "../tenancy.js";

const MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
const MAX_JSON_UPLOAD_BYTES = Math.ceil((MAX_ARCHIVE_BYTES * 4) / 3) + 16_384;

export async function readJsonObject(
  context: Context<ApiEnvironment>,
): Promise<Record<string, unknown>> {
  let value: unknown;
  try {
    value = await context.req.json();
  } catch {
    throw new DomainError("VALIDATION_FAILED", "A valid JSON body is required", 400);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DomainError("VALIDATION_FAILED", "A JSON object is required", 400);
  }
  return value as Record<string, unknown>;
}

export async function workspaceUser(context: Context<ApiEnvironment>) {
  const services = context.get("services");
  if (!services) throw new WorkspaceAccessError();
  const workspaceId = context.req.param("workspaceId");
  if (!workspaceId) throw new WorkspaceAccessError();
  return requireUserPrincipal(
    services.controlDatabase.pool,
    context.get("session"),
    workspaceId,
  );
}

export async function workspacePrincipal(
  context: Context<ApiEnvironment>,
  action: "skills:read" | "skills:write",
): Promise<Principal> {
  const workspaceId = context.req.param("workspaceId");
  const servicePrincipal = context.get("servicePrincipal");
  if (servicePrincipal) {
    if (!workspaceId || servicePrincipal.workspaceId !== workspaceId) {
      throw new WorkspaceAccessError();
    }
    authorize(servicePrincipal, action);
    return servicePrincipal;
  }
  const principal = await workspaceUser(context);
  authorize(principal, action);
  return principal;
}

export function requirePrincipal(context: Context<ApiEnvironment>): Principal {
  const principal = context.get("principal");
  if (!principal) {
    throw new DomainError("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
  }
  return principal;
}

export function requireIdempotencyKey(context: Context<ApiEnvironment>): string {
  const value = context.req.header("idempotency-key")?.trim();
  if (!value) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "An Idempotency-Key header is required",
      400,
    );
  }
  return value;
}

function decodeBase64(value: unknown): Uint8Array {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_JSON_UPLOAD_BYTES ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "bundleBase64 must be valid base64 within the upload limit",
      400,
      { field: "bundleBase64" },
    );
  }
  const binary = atob(value);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new DomainError(
      "SKILL_BUNDLE_TOO_LARGE",
      "The compressed skill bundle exceeds 10 MiB",
      400,
    );
  }
  return bytes;
}

export async function readBundleUpload(context: Context<ApiEnvironment>): Promise<{
  readonly archiveBytes: Uint8Array;
  readonly fields: Readonly<Record<string, unknown>>;
}> {
  const contentLength = Number(context.req.header("content-length"));
  const mediaType = context.req.header("content-type")?.split(";", 1)[0]?.trim();
  if (mediaType === "application/zip") {
    if (Number.isFinite(contentLength) && contentLength > MAX_ARCHIVE_BYTES) {
      throw new DomainError(
        "SKILL_BUNDLE_TOO_LARGE",
        "The compressed skill bundle exceeds 10 MiB",
        400,
      );
    }
    const archiveBytes = new Uint8Array(await context.req.arrayBuffer());
    if (archiveBytes.byteLength === 0 || archiveBytes.byteLength > MAX_ARCHIVE_BYTES) {
      throw new DomainError(
        archiveBytes.byteLength === 0
          ? "SKILL_BUNDLE_INVALID"
          : "SKILL_BUNDLE_TOO_LARGE",
        archiveBytes.byteLength === 0
          ? "A ZIP skill bundle is required"
          : "The compressed skill bundle exceeds 10 MiB",
        400,
      );
    }
    return {
      archiveBytes,
      fields: {
        visibility: context.req.query("visibility"),
        baseVersionId: context.req.header("x-skillplane-base-version-id"),
        proposedBump: context.req.header("x-skillplane-proposed-bump"),
        changeSummary: context.req.header("x-skillplane-change-summary"),
      },
    };
  }
  if (mediaType !== "application/json") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Use application/zip or application/json with bundleBase64",
      400,
      { field: "content-type" },
    );
  }
  if (Number.isFinite(contentLength) && contentLength > MAX_JSON_UPLOAD_BYTES) {
    throw new DomainError(
      "SKILL_BUNDLE_TOO_LARGE",
      "The encoded skill bundle exceeds the upload limit",
      400,
    );
  }
  const fields = await readJsonObject(context);
  return { archiveBytes: decodeBase64(fields.bundleBase64), fields };
}

export function parseStringField(
  value: unknown,
  field: string,
  options: { readonly maxLength?: number } = {},
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized || normalized.length > (options.maxLength ?? 500)) {
    throw new DomainError("VALIDATION_FAILED", `${field} is required`, 400, { field });
  }
  return normalized;
}

export function publicSkillVersion(
  version: SkillVersionRecord,
): Omit<SkillVersionRecord, "objectKey"> {
  return {
    id: version.id,
    workspaceId: version.workspaceId,
    skillId: version.skillId,
    revision: version.revision,
    semanticVersion: version.semanticVersion,
    status: version.status,
    baseVersionId: version.baseVersionId,
    proposedBump: version.proposedBump,
    source: version.source,
    digest: version.digest,
    byteSize: version.byteSize,
    manifest: version.manifest,
    learningMetadata: version.learningMetadata,
    amendmentOperations: version.amendmentOperations,
    callerDeclaration: version.callerDeclaration,
    policyDecision: version.policyDecision,
    changeSummary: version.changeSummary,
    createdByActorType: version.createdByActorType,
    createdByActorId: version.createdByActorId,
    createdByAgent: version.createdByAgent,
    createdByModel: version.createdByModel,
    createdForUserId: version.createdForUserId,
    publishedAt: version.publishedAt,
    createdAt: version.createdAt,
  };
}

export function publicPublishedSkillVersion(version: SkillVersionRecord) {
  return {
    id: version.id,
    workspaceId: version.workspaceId,
    skillId: version.skillId,
    revision: version.revision,
    semanticVersion: version.semanticVersion,
    status: version.status,
    baseVersionId: version.baseVersionId,
    proposedBump: version.proposedBump,
    source: version.source,
    digest: version.digest,
    byteSize: version.byteSize,
    manifest: version.manifest,
    changeSummary: version.changeSummary,
    publishedAt: version.publishedAt,
    createdAt: version.createdAt,
  };
}

export function isPostgresUniqueViolation(
  error: unknown,
  constraint?: string,
): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { code?: unknown; constraint?: unknown };
  return (
    record.code === "23505" &&
    (constraint === undefined || record.constraint === constraint)
  );
}

export async function writeApiAudit(
  client: PoolClient,
  principal: Principal,
  event: {
    readonly eventType: string;
    readonly action: string;
    readonly requestId: string;
    readonly resourceType?: string;
    readonly resourceId?: string;
    readonly skillId?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  },
): Promise<void> {
  await writeAuditEvent(client, {
    workspaceId: principal.workspaceId,
    eventType: event.eventType,
    action: event.action,
    outcome: "success",
    actorType: principal.kind === "user" ? "user" : "service_principal",
    actorId: principal.actorId,
    userId:
      principal.kind === "user"
        ? principal.userId
        : (principal.delegatedUserId ?? null),
    requestId: event.requestId,
    ...(event.resourceType ? { resourceType: event.resourceType } : {}),
    ...(event.resourceId ? { resourceId: event.resourceId } : {}),
    ...(event.skillId ? { skillId: event.skillId } : {}),
    ...(event.metadata ? { metadata: event.metadata } : {}),
    channel: "app",
    retentionClass: "permanent",
  });
}

export function parseOptionalExpiry(value: unknown, now = new Date()): Date | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") {
    throw new DomainError("VALIDATION_FAILED", "Expiry must be an ISO date", 400, {
      field: "expiresAt",
    });
  }
  const expiresAt = new Date(value);
  if (
    !Number.isFinite(expiresAt.getTime()) ||
    expiresAt <= now ||
    expiresAt.getTime() > now.getTime() + 366 * 24 * 60 * 60 * 1000
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Expiry must be within the next 366 days",
      400,
      { field: "expiresAt" },
    );
  }
  return expiresAt;
}
