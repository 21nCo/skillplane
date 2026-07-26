import { AuthorizationError, DomainError } from "./errors.js";
import type { Principal, ServicePrincipalScope, WorkspaceRole } from "./principal.js";

export const WORKSPACE_ACTIONS = [
  "workspace:read",
  "workspace:update",
  "members:read",
  "members:write",
  "skills:read",
  "skills:write",
  "skills:amend",
  "skills:publish",
  "contexts:read",
  "contexts:write",
  "analytics:read",
  "audit:read",
  "workspace:delete",
] as const;

export type WorkspaceAction = (typeof WORKSPACE_ACTIONS)[number];

const roleActions: Readonly<Record<WorkspaceRole, ReadonlySet<WorkspaceAction>>> = {
  viewer: new Set([
    "workspace:read",
    "members:read",
    "skills:read",
    "contexts:read",
    "analytics:read",
  ]),
  editor: new Set([
    "workspace:read",
    "members:read",
    "skills:read",
    "skills:write",
    "skills:amend",
    "contexts:read",
    "contexts:write",
    "analytics:read",
  ]),
  admin: new Set([
    "workspace:read",
    "workspace:update",
    "members:read",
    "members:write",
    "skills:read",
    "skills:write",
    "skills:amend",
    "skills:publish",
    "contexts:read",
    "contexts:write",
    "analytics:read",
    "audit:read",
  ]),
  owner: new Set(WORKSPACE_ACTIONS),
};

const actionScope: Readonly<Partial<Record<WorkspaceAction, ServicePrincipalScope>>> = {
  "workspace:read": "skills:read",
  "members:read": "members:read",
  "members:write": "members:write",
  "skills:read": "skills:read",
  "skills:write": "skills:write",
  "skills:amend": "skills:amend",
  "contexts:read": "contexts:read",
  "contexts:write": "contexts:write",
  "analytics:read": "analytics:read",
  "audit:read": "audit:read",
};

export function canPerform(principal: Principal, action: WorkspaceAction): boolean {
  if (principal.kind === "user") {
    return roleActions[principal.role].has(action);
  }
  const scope = actionScope[action];
  return (
    roleActions[principal.role].has(action) &&
    scope !== undefined &&
    principal.scopes.includes(scope)
  );
}

export function authorize(principal: Principal, action: WorkspaceAction): void {
  const scope = actionScope[action];
  if (
    principal.kind === "service" &&
    scope &&
    roleActions[principal.role].has(action) &&
    !principal.scopes.includes(scope)
  ) {
    throw new DomainError(
      "AUTH_SCOPE_REQUIRED",
      "The service credential lacks a required scope",
      403,
    );
  }
  if (!canPerform(principal, action)) {
    throw new AuthorizationError();
  }
}

export function actionsForRole(role: WorkspaceRole): readonly WorkspaceAction[] {
  return WORKSPACE_ACTIONS.filter((action) => roleActions[role].has(action));
}
