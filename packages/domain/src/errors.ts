export type DomainErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "AUTH_CSRF_INVALID"
  | "AUTH_INVALID"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "VALIDATION_FAILED"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE"
  | "WORKSPACE_FORBIDDEN"
  | "WORKSPACE_SLUG_CONFLICT"
  | "WORKSPACE_FINAL_OWNER"
  | "INVITATION_INVALID"
  | "INVITATION_EXPIRED"
  | "INVITATION_REVOKED"
  | "INVITATION_USED"
  | "INVITATION_EMAIL_MISMATCH"
  | "SERVICE_PRINCIPAL_INVALID"
  | "AUTH_SCOPE_REQUIRED"
  | "SKILL_SLUG_CONFLICT"
  | "SKILL_NOT_FOUND"
  | "SKILL_VERSION_NOT_FOUND"
  | "SKILL_VERSION_CONFLICT"
  | "SKILL_PUBLISH_CONFLICT"
  | "LEARNING_METADATA_INVALID"
  | "AMENDMENT_POLICY_INVALID"
  | "AMENDMENT_NOT_FOUND"
  | "REVIEW_NOT_FOUND"
  | "SKILL_ARCHIVED"
  | "SKILL_VISIBILITY_INVALID"
  | "SKILL_BUNDLE_INVALID"
  | "SKILL_BUNDLE_TOO_LARGE"
  | "SKILL_PATH_INVALID"
  | "SKILL_PATH_DUPLICATE"
  | "SKILL_LINK_INVALID"
  | "SKILL_FILE_NOT_FOUND"
  | "CONTEXT_NOT_FOUND"
  | "CONTEXT_ARCHIVED"
  | "CONTEXT_SLUG_CONFLICT"
  | "CONTEXT_LIMIT_REACHED"
  | "CONTEXT_REVISION_CONFLICT"
  | "NOTE_NOT_FOUND"
  | "NOTE_ARCHIVED"
  | "NOTE_LIMIT_REACHED"
  | "NOTE_REVISION_CONFLICT"
  | "R2_WRITE_FAILED"
  | "R2_READ_FAILED"
  | "R2_OBJECT_MISMATCH"
  | "R2_CLEANUP_FAILED"
  | "CURSOR_INVALID"
  | "CURSOR_FILTER_MISMATCH"
  | "IDEMPOTENCY_KEY_REQUIRED"
  | "IDEMPOTENCY_KEY_REUSED"
  | "IDEMPOTENCY_IN_PROGRESS"
  | "AUDIT_WRITE_FAILED";

export class DomainError extends Error {
  readonly code: DomainErrorCode;
  readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 500 | 502 | 503;
  readonly details: Readonly<Record<string, unknown>> | undefined;

  constructor(
    code: DomainErrorCode,
    message: string,
    status: DomainError["status"],
    details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "DomainError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AuthenticationRequiredError extends DomainError {
  constructor() {
    super("AUTHENTICATION_REQUIRED", "Authentication is required", 401);
    this.name = "AuthenticationRequiredError";
  }
}

export class InvalidAuthenticationError extends DomainError {
  constructor() {
    super("AUTH_INVALID", "The supplied credential is invalid", 401);
    this.name = "InvalidAuthenticationError";
  }
}

export class WorkspaceAccessError extends DomainError {
  constructor() {
    super("NOT_FOUND", "Workspace resource was not found", 404);
    this.name = "WorkspaceAccessError";
  }
}

export class AuthorizationError extends DomainError {
  constructor() {
    super(
      "WORKSPACE_FORBIDDEN",
      "This principal is not allowed to perform that action",
      403,
    );
    this.name = "AuthorizationError";
  }
}
