import {
  AuthenticationRequiredError,
  isWorkspaceRole,
  WorkspaceAccessError,
  type Principal,
} from "@skillplane/domain";
import type { AuthFnSession } from "authfn";
import type { Pool } from "pg";

interface MembershipRow {
  readonly id: string;
  readonly role: string;
  readonly workspace_id: string;
  readonly user_id: string;
  readonly email: string | null;
}

export async function resolveUserPrincipal(
  pool: Pool,
  session: AuthFnSession | null,
  workspaceId: string | undefined,
): Promise<Principal> {
  if (!session) {
    throw new AuthenticationRequiredError();
  }
  if (!workspaceId) {
    throw new WorkspaceAccessError();
  }
  const result = await pool.query<MembershipRow>(
    `SELECT m.id, m.role, m.workspace_id, m.user_id, u.primary_email AS email
       FROM workspace_memberships m
       JOIN authfn_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.user_id = $2
      LIMIT 1`,
    [workspaceId, session.actorId],
  );
  const membership = result.rows[0];
  if (!membership || !isWorkspaceRole(membership.role)) {
    throw new WorkspaceAccessError();
  }
  return {
    kind: "user",
    actorId: membership.user_id,
    userId: membership.user_id,
    sessionId: session.id,
    workspaceId: membership.workspace_id,
    role: membership.role,
    ...(membership.email ? { email: membership.email } : {}),
  };
}
