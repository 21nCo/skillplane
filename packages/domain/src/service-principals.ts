import { DomainError } from "./errors.js";
import {
  SERVICE_PRINCIPAL_SCOPES,
  type ServicePrincipalScope,
  type WorkspaceRole,
} from "./principal.js";
import { parseWorkspaceRole } from "./memberships.js";

export type ServicePrincipalRole = Exclude<WorkspaceRole, "owner">;

export function normalizeServicePrincipalName(value: unknown): string {
  if (typeof value !== "string") {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Service principal name is required",
      400,
    );
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 120) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Service principal name must contain 1 to 120 characters",
      400,
      { field: "name" },
    );
  }
  return name;
}

export function parseServicePrincipalRole(value: unknown): ServicePrincipalRole {
  return parseWorkspaceRole(value) as ServicePrincipalRole;
}

export function parseServicePrincipalScopes(
  value: unknown,
): readonly ServicePrincipalScope[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "Select at least one service principal scope",
      400,
      { field: "scopes" },
    );
  }
  const scopes = [...new Set(value)];
  if (
    scopes.some(
      (scope) =>
        typeof scope !== "string" ||
        !(SERVICE_PRINCIPAL_SCOPES as readonly string[]).includes(scope),
    )
  ) {
    throw new DomainError(
      "VALIDATION_FAILED",
      "One or more service principal scopes are invalid",
      400,
      { field: "scopes" },
    );
  }
  return (scopes as ServicePrincipalScope[]).sort();
}

export function assertServicePrincipalActive(input: {
  readonly revokedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly requiredScope?: ServicePrincipalScope;
  readonly scopes: readonly ServicePrincipalScope[];
  readonly now?: Date;
}): void {
  const now = input.now ?? new Date();
  if (input.revokedAt || (input.expiresAt && input.expiresAt <= now)) {
    throw new DomainError(
      "SERVICE_PRINCIPAL_INVALID",
      "The service credential is invalid",
      401,
    );
  }
  if (input.requiredScope && !input.scopes.includes(input.requiredScope)) {
    throw new DomainError(
      "AUTH_SCOPE_REQUIRED",
      "The service credential lacks a required scope",
      403,
    );
  }
}
