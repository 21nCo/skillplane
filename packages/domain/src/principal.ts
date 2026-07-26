export const WORKSPACE_ROLES = ["viewer", "editor", "admin", "owner"] as const;
export type WorkspaceRole = (typeof WORKSPACE_ROLES)[number];

export const SERVICE_PRINCIPAL_SCOPES = [
  "skills:read",
  "skills:write",
  "skills:amend",
  "contexts:read",
  "contexts:write",
  "members:read",
  "members:write",
  "analytics:read",
  "audit:read",
] as const;
export type ServicePrincipalScope = (typeof SERVICE_PRINCIPAL_SCOPES)[number];

interface PrincipalBase {
  readonly actorId: string;
  readonly workspaceId: string;
  readonly displayName?: string;
}

export interface UserPrincipal extends PrincipalBase {
  readonly kind: "user";
  readonly userId: string;
  readonly sessionId: string;
  readonly role: WorkspaceRole;
  readonly email?: string;
}

export interface ServicePrincipal extends PrincipalBase {
  readonly kind: "service";
  readonly servicePrincipalId: string;
  readonly role: Exclude<WorkspaceRole, "owner">;
  readonly scopes: readonly ServicePrincipalScope[];
  readonly delegatedUserId?: string;
}

export type Principal = UserPrincipal | ServicePrincipal;

export function isWorkspaceRole(value: string): value is WorkspaceRole {
  return (WORKSPACE_ROLES as readonly string[]).includes(value);
}

export function principalAuditActor(principal: Principal): {
  actorType: "user" | "service_principal";
  actorId: string;
} {
  return {
    actorType: principal.kind === "user" ? "user" : "service_principal",
    actorId: principal.actorId,
  };
}
