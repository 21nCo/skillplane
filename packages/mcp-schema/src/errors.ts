import { z } from "zod";

export const MCP_ERROR_CODES = [
  "AUTHENTICATION_REQUIRED",
  "AUTH_INVALID",
  "AUTH_SCOPE_REQUIRED",
  "WORKSPACE_FORBIDDEN",
  "VALIDATION_FAILED",
  "NOT_FOUND",
  "SKILL_NOT_FOUND",
  "SKILL_VERSION_NOT_FOUND",
  "SKILL_VERSION_CONFLICT",
  "SKILL_ARCHIVED",
  "SKILL_BUNDLE_INVALID",
  "SKILL_BUNDLE_TOO_LARGE",
  "SKILL_PATH_INVALID",
  "SKILL_FILE_NOT_FOUND",
  "LEARNING_METADATA_INVALID",
  "AMENDMENT_POLICY_DENIED",
  "CONTEXT_NOT_FOUND",
  "CONTEXT_ARCHIVED",
  "CONTEXT_SLUG_CONFLICT",
  "CONTEXT_LIMIT_REACHED",
  "CONTEXT_REVISION_CONFLICT",
  "CONTEXT_METADATA_CONFLICT",
  "NOTE_NOT_FOUND",
  "NOTE_ARCHIVED",
  "NOTE_LIMIT_REACHED",
  "NOTE_REVISION_CONFLICT",
  "IDEMPOTENCY_KEY_REQUIRED",
  "IDEMPOTENCY_KEY_REUSED",
  "IDEMPOTENCY_IN_PROGRESS",
  "CURSOR_INVALID",
  "CURSOR_FILTER_MISMATCH",
  "R2_WRITE_FAILED",
  "R2_READ_FAILED",
  "R2_OBJECT_MISMATCH",
  "ASSET_TOO_LARGE",
  "AUDIT_WRITE_FAILED",
  "DATABASE_UNAVAILABLE",
  "INTERNAL_ERROR",
] as const;

export type McpErrorCode = (typeof MCP_ERROR_CODES)[number];

export const mcpErrorSchema = z
  .object({
    ok: z.literal(false),
    error: z
      .object({
        code: z.enum(MCP_ERROR_CODES),
        message: z.string().min(1).max(500),
        retryable: z.boolean(),
        requestId: z.string().min(1).max(200),
        details: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))
          .optional(),
      })
      .strict(),
  })
  .strict();

export interface McpSafeError {
  readonly code: McpErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
}

export class McpToolError extends Error implements McpSafeError {
  readonly code: McpErrorCode;
  readonly retryable: boolean;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 503;

  constructor(
    code: McpErrorCode,
    message: string,
    options: {
      readonly retryable?: boolean;
      readonly status?: McpToolError["status"];
      readonly details?: Readonly<Record<string, string | number | boolean | null>>;
    } = {},
  ) {
    super(message);
    this.name = "McpToolError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status ?? 400;
    if (options.details) this.details = options.details;
  }
}
