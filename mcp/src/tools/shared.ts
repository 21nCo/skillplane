import type { ApiServices } from "@skillplane/api";
import {
  BundlePathError,
  BundleValidationError,
  StorageError,
} from "@skillplane/storage";
import {
  DomainError,
  type MutationAuditContext,
  type Principal,
  type WorkspaceRole,
} from "@skillplane/domain";
import {
  MCP_ERROR_CODES,
  McpToolError,
  type CallerDeclaration,
  type McpErrorCode,
} from "@skillplane/mcp-schema";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { McpIdentity } from "../auth.js";
import {
  emitMcpOperationalEvent,
  persistMcpAudit,
  type McpAuditWriter,
} from "../audit.js";
import type { McpCursorCodec } from "../pagination.js";

export interface McpToolRuntime {
  readonly services: ApiServices;
  readonly identity: McpIdentity;
  readonly audit: McpAuditWriter;
  readonly cursors: McpCursorCodec;
  readonly downloadSecret: string;
  readonly origin: string;
  readonly now: () => Date;
}

export interface ToolAuditScope {
  workspaceId?: string;
  resourceType?: "workspace" | "skill" | "skill_version" | "context";
  resourceId?: string;
  skillId?: string;
  versionId?: string;
  versionDigest?: string;
  contextId?: string;
}

export interface ToolExecution {
  readonly requestId: string;
  readonly scope: ToolAuditScope;
  setScope(values: ToolAuditScope): void;
}

export interface ToolSuccess<T extends object> {
  readonly output: T;
}

export function mutationAuditContext(
  runtime: McpToolRuntime,
  caller: CallerDeclaration,
): MutationAuditContext {
  return {
    channel: "mcp",
    credential: {
      kind: runtime.identity.credentialKind,
      id: runtime.identity.credentialId,
      ...(runtime.identity.kind === "oauth"
        ? { clientId: runtime.identity.clientId }
        : {}),
    },
    caller,
  };
}

function safeCode(value: string): value is McpErrorCode {
  return (MCP_ERROR_CODES as readonly string[]).includes(value);
}

function safeDetails(
  details: Readonly<Record<string, unknown>> | undefined,
): Readonly<Record<string, string | number | boolean | null>> | undefined {
  if (!details) return undefined;
  const result: Record<string, string | number | boolean | null> = {};
  for (const [key, value] of Object.entries(details).slice(0, 20)) {
    if (value === null || typeof value === "number" || typeof value === "boolean") {
      result[key.slice(0, 120)] = value;
    } else if (typeof value === "string") {
      result[key.slice(0, 120)] = value.slice(0, 500);
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function mapMcpToolError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  if (error instanceof DomainError) {
    const details = safeDetails(error.details);
    const code: McpErrorCode = safeCode(error.code)
      ? error.code
      : error.status === 404
        ? "NOT_FOUND"
        : error.status === 403
          ? "WORKSPACE_FORBIDDEN"
          : error.status >= 500
            ? "DATABASE_UNAVAILABLE"
            : "VALIDATION_FAILED";
    return new McpToolError(code, error.message, {
      status:
        error.status === 429
          ? 429
          : error.status === 502 || error.status === 503
            ? 503
            : error.status,
      retryable: error.status >= 500,
      ...(details ? { details } : {}),
    });
  }
  if (error instanceof StorageError) {
    const code =
      error.code === "R2_OBJECT_MISMATCH" ? "R2_OBJECT_MISMATCH" : "R2_READ_FAILED";
    return new McpToolError(code, "The requested skill content is unavailable", {
      status: 503,
      retryable: true,
    });
  }
  if (error instanceof BundlePathError) {
    return new McpToolError(
      "SKILL_PATH_INVALID",
      "The requested asset path is invalid",
    );
  }
  if (error instanceof BundleValidationError) {
    return new McpToolError(
      error.code === "SKILL_PATH_INVALID" ? "SKILL_PATH_INVALID" : "R2_OBJECT_MISMATCH",
      "The stored skill bundle is invalid",
      { status: 503, retryable: true },
    );
  }
  if (error instanceof Error) {
    if (error.message === "WORKSPACE_FORBIDDEN") {
      return new McpToolError(
        "WORKSPACE_FORBIDDEN",
        "The workspace resource was not found",
        { status: 403 },
      );
    }
    if (error.message === "SKILL_FILE_NOT_FOUND") {
      return new McpToolError(
        "SKILL_FILE_NOT_FOUND",
        "The requested skill asset was not found",
        { status: 404 },
      );
    }
  }
  return new McpToolError("INTERNAL_ERROR", "The MCP request could not be completed", {
    status: 500,
    retryable: true,
  });
}

function result(output: object): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(output) }],
    structuredContent: output as Record<string, unknown>,
  };
}

function errorResult(error: McpToolError, requestId: string): CallToolResult {
  const body = {
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      requestId,
      ...(error.details ? { details: error.details } : {}),
    },
  };
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}

export async function executeReadTool<T extends object>(
  runtime: McpToolRuntime,
  tool: string,
  caller: CallerDeclaration,
  operation: (execution: ToolExecution) => Promise<ToolSuccess<T>>,
): Promise<CallToolResult> {
  const requestId = `mcp:${crypto.randomUUID()}`;
  const startedAt = performance.now();
  const scope: ToolAuditScope = {};
  const execution: ToolExecution = {
    requestId,
    scope,
    setScope(values) {
      Object.assign(scope, values);
    },
  };
  try {
    const success = await operation(execution);
    if (!scope.workspaceId) {
      throw new McpToolError(
        "INTERNAL_ERROR",
        "The MCP request could not be attributed",
        { status: 500, retryable: true },
      );
    }
    const latencyMs = Math.max(0, performance.now() - startedAt);
    await persistMcpAudit(runtime.audit, {
      workspaceId: scope.workspaceId,
      requestId,
      tool,
      outcome: "success",
      identity: runtime.identity,
      caller,
      ...(scope.resourceType ? { resourceType: scope.resourceType } : {}),
      ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
      ...(scope.skillId ? { skillId: scope.skillId } : {}),
      ...(scope.versionId ? { versionId: scope.versionId } : {}),
      ...(scope.versionDigest ? { versionDigest: scope.versionDigest } : {}),
      ...(scope.contextId ? { contextId: scope.contextId } : {}),
      latencyMs,
    });
    emitMcpOperationalEvent({
      requestId,
      tool,
      outcome: "success",
      actorType: runtime.identity.actorType,
      actorId: runtime.identity.actorId,
      ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
      latencyMs,
    });
    return result(success.output);
  } catch (caught) {
    const error = mapMcpToolError(caught);
    const latencyMs = Math.max(0, performance.now() - startedAt);
    const outcome =
      error.status === 401 || error.status === 403 || error.status === 404
        ? "denied"
        : "error";
    if (scope.workspaceId && error.code !== "AUDIT_WRITE_FAILED") {
      try {
        await persistMcpAudit(runtime.audit, {
          workspaceId: scope.workspaceId,
          requestId,
          tool,
          outcome,
          identity: runtime.identity,
          caller,
          ...(scope.resourceType ? { resourceType: scope.resourceType } : {}),
          ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
          ...(scope.skillId ? { skillId: scope.skillId } : {}),
          ...(scope.versionId ? { versionId: scope.versionId } : {}),
          ...(scope.versionDigest ? { versionDigest: scope.versionDigest } : {}),
          ...(scope.contextId ? { contextId: scope.contextId } : {}),
          errorCode: error.code,
          latencyMs,
        });
      } catch (auditError) {
        const failedAudit = mapMcpToolError(auditError);
        emitMcpOperationalEvent({
          requestId,
          tool,
          outcome: "error",
          errorCode: failedAudit.code,
          actorType: runtime.identity.actorType,
          actorId: runtime.identity.actorId,
          latencyMs,
        });
        return errorResult(failedAudit, requestId);
      }
    }
    emitMcpOperationalEvent({
      requestId,
      tool,
      outcome,
      errorCode: error.code,
      actorType: runtime.identity.actorType,
      actorId: runtime.identity.actorId,
      ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
      latencyMs,
    });
    return errorResult(error, requestId);
  }
}

export async function executeMutationTool<T extends object>(
  runtime: McpToolRuntime,
  tool: string,
  caller: CallerDeclaration,
  operation: (execution: ToolExecution) => Promise<ToolSuccess<T>>,
): Promise<CallToolResult> {
  const requestId = `mcp:${crypto.randomUUID()}`;
  const startedAt = performance.now();
  const scope: ToolAuditScope = {};
  const execution: ToolExecution = {
    requestId,
    scope,
    setScope(values) {
      Object.assign(scope, values);
    },
  };
  try {
    const success = await operation(execution);
    if (!scope.workspaceId) {
      throw new McpToolError(
        "INTERNAL_ERROR",
        "The MCP request could not be attributed",
        { status: 500, retryable: true },
      );
    }
    const latencyMs = Math.max(0, performance.now() - startedAt);
    emitMcpOperationalEvent({
      requestId,
      tool,
      outcome: "success",
      actorType: runtime.identity.actorType,
      actorId: runtime.identity.actorId,
      ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
      latencyMs,
    });
    return result(success.output);
  } catch (caught) {
    const error = mapMcpToolError(caught);
    const latencyMs = Math.max(0, performance.now() - startedAt);
    const outcome =
      error.status === 401 || error.status === 403 || error.status === 404
        ? "denied"
        : "error";
    if (scope.workspaceId && error.code !== "AUDIT_WRITE_FAILED") {
      try {
        await persistMcpAudit(runtime.audit, {
          workspaceId: scope.workspaceId,
          requestId,
          tool,
          outcome,
          identity: runtime.identity,
          caller,
          ...(scope.resourceType ? { resourceType: scope.resourceType } : {}),
          ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
          ...(scope.skillId ? { skillId: scope.skillId } : {}),
          ...(scope.versionId ? { versionId: scope.versionId } : {}),
          ...(scope.versionDigest ? { versionDigest: scope.versionDigest } : {}),
          ...(scope.contextId ? { contextId: scope.contextId } : {}),
          errorCode: error.code,
          latencyMs,
          countMetric: false,
        });
      } catch (auditError) {
        const failedAudit = mapMcpToolError(auditError);
        emitMcpOperationalEvent({
          requestId,
          tool,
          outcome: "error",
          errorCode: failedAudit.code,
          actorType: runtime.identity.actorType,
          actorId: runtime.identity.actorId,
          latencyMs,
        });
        return errorResult(failedAudit, requestId);
      }
    }
    emitMcpOperationalEvent({
      requestId,
      tool,
      outcome,
      errorCode: error.code,
      actorType: runtime.identity.actorType,
      actorId: runtime.identity.actorId,
      ...(scope.resourceId ? { resourceId: scope.resourceId } : {}),
      latencyMs,
    });
    return errorResult(error, requestId);
  }
}

export function roleCanReadCandidates(
  role: WorkspaceRole,
  principal: Principal,
): boolean {
  if (role === "viewer") return false;
  return principal.kind === "user" || principal.scopes.includes("skills:amend");
}
