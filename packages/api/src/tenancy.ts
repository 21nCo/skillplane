import type { AuthFnSession } from "@authfn/core";
import {
  DomainError,
  WorkspaceAccessError,
  isWorkspaceRole,
  type UserPrincipal,
  type WorkspaceRole,
} from "@skillplane/domain";
import type { Pool, PoolClient } from "pg";

interface MembershipRow {
  readonly id: string;
  readonly role: string;
  readonly user_id: string;
  readonly workspace_id: string;
  readonly email: string | null;
  readonly display_name: string | null;
}

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

async function stablePersonalSlug(userId: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(userId),
  );
  const suffix = [...new Uint8Array(digest)]
    .slice(0, 10)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `personal-${suffix}`;
}

export async function ensurePersonalWorkspace(
  pool: Pool,
  session: AuthFnSession,
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
      session.actorId,
    ]);
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM workspaces
        WHERE kind = 'personal' AND personal_owner_user_id = $1
        LIMIT 1`,
      [session.actorId],
    );
    let workspaceId = existing.rows[0]?.id;
    if (!workspaceId) {
      workspaceId = id("workspace");
      const email =
        typeof session.subject.email === "string" ? session.subject.email : undefined;
      const label = email?.split("@")[0]?.trim();
      await client.query(
        `INSERT INTO workspaces
           (id, workspace_id, slug, name, kind, created_by_user_id,
            personal_owner_user_id)
         VALUES ($1, $1, $2, $3, 'personal', $4, $4)`,
        [
          workspaceId,
          await stablePersonalSlug(session.actorId),
          label ? `${label}'s workspace` : "Personal workspace",
          session.actorId,
        ],
      );
    }
    await client.query(
      `INSERT INTO workspace_memberships
         (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'owner')
       ON CONFLICT (workspace_id, user_id)
       DO UPDATE SET role = 'owner', updated_at = now()`,
      [id("membership"), workspaceId, session.actorId],
    );
    await client.query("COMMIT");
    return workspaceId;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function requireUserPrincipal(
  pool: Pool,
  session: AuthFnSession | null,
  workspaceId: string,
): Promise<UserPrincipal> {
  if (!session) {
    throw new DomainError("AUTHENTICATION_REQUIRED", "A user session is required", 401);
  }
  const result = await pool.query<MembershipRow>(
    `SELECT m.id, m.role, m.user_id, m.workspace_id, u.primary_email AS email,
            u.metadata->>'displayName' AS display_name
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
    ...(membership.display_name ? { displayName: membership.display_name } : {}),
  };
}

export async function lockWorkspaceMemberships(
  client: PoolClient,
  workspaceId: string,
): Promise<readonly MembershipRow[]> {
  const result = await client.query<MembershipRow>(
    `SELECT m.id, m.role, m.user_id, m.workspace_id, u.primary_email AS email,
            u.metadata->>'displayName' AS display_name
       FROM workspace_memberships m
       JOIN authfn_users u ON u.id = m.user_id
      WHERE m.workspace_id = $1
      ORDER BY m.created_at, m.id
      FOR UPDATE OF m`,
    [workspaceId],
  );
  return result.rows;
}

export function membershipRole(
  rows: readonly MembershipRow[],
  userId: string,
): WorkspaceRole {
  const row = rows.find((candidate) => candidate.user_id === userId);
  if (!row || !isWorkspaceRole(row.role)) throw new WorkspaceAccessError();
  return row.role;
}
