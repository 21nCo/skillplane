import { DomainError } from "./errors.js";
import { WORKSPACE_ROLES, type WorkspaceRole, isWorkspaceRole } from "./principal.js";

const rank: Readonly<Record<WorkspaceRole, number>> = {
  viewer: 0,
  editor: 1,
  admin: 2,
  owner: 3,
};

export function parseWorkspaceRole(
  value: unknown,
  options: { readonly allowOwner?: boolean } = {},
): WorkspaceRole {
  if (
    typeof value !== "string" ||
    !isWorkspaceRole(value) ||
    (value === "owner" && !options.allowOwner)
  ) {
    throw new DomainError("VALIDATION_FAILED", "Select a valid workspace role", 400, {
      field: "role",
    });
  }
  return value;
}

export function canManageMembership(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole?: WorkspaceRole,
): boolean {
  if (actorRole === "owner") return true;
  if (actorRole !== "admin") return false;
  return targetRole !== "owner" && nextRole !== "owner";
}

export function assertMembershipChange(
  actorRole: WorkspaceRole,
  targetRole: WorkspaceRole,
  nextRole?: WorkspaceRole,
): void {
  if (!canManageMembership(actorRole, targetRole, nextRole)) {
    throw new DomainError(
      "WORKSPACE_FORBIDDEN",
      "This role cannot manage the selected membership",
      403,
    );
  }
}

export function assertOwnerRemains(ownerCount: number, removingOwner: boolean): void {
  if (removingOwner && ownerCount <= 1) {
    throw new DomainError(
      "WORKSPACE_FORBIDDEN",
      "Assign another owner before removing the final owner",
      403,
    );
  }
}

export function roleAtLeast(role: WorkspaceRole, required: WorkspaceRole): boolean {
  return rank[role] >= rank[required];
}

export { WORKSPACE_ROLES };
