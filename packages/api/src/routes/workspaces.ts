import {
  DomainError,
  assertMembershipChange,
  assertOwnerRemains,
  authorize,
  normalizeWorkspaceName,
  normalizeWorkspaceSlug,
  parseWorkspaceRole,
} from "@skillplane/domain";
import { selectInitialWorkspaceRegion } from "@skillplane/control-plane";
import type { Hono } from "hono";
import { writeControlPlaneAudit } from "../control-audit.js";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import { lockWorkspaceMemberships, membershipRole } from "../tenancy.js";
import { isPostgresUniqueViolation, readJsonObject, workspaceUser } from "./shared.js";

function id(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function registerWorkspaceRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/workspaces", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const result = await services.controlDatabase.pool.query<{
      id: string;
      kind: string;
      slug: string;
      name: string;
      role: string;
      updated_at: Date;
    }>(
      `SELECT w.id, w.kind, w.slug, w.name, m.role, w.updated_at
         FROM workspace_memberships m
         JOIN workspaces w ON w.id = m.workspace_id
        WHERE m.user_id = $1
        ORDER BY CASE w.kind WHEN 'personal' THEN 0 ELSE 1 END, w.name, w.id`,
      [session.actorId],
    );
    return context.json(
      success(context, {
        workspaces: result.rows.map((row) => ({
          id: row.id,
          kind: row.kind,
          slug: row.slug,
          name: row.name,
          role: row.role,
          updatedAt: row.updated_at.toISOString(),
        })),
      }),
    );
  });

  app.post("/api/v1/workspaces", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const name = normalizeWorkspaceName(body.name);
    const slug = normalizeWorkspaceSlug(body.slug);
    const workspaceId = id("workspace");
    const homeRegionId = selectInitialWorkspaceRegion(
      workspaceId,
      services.workspaceRegions,
    );
    const client = await services.controlDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workspaces
           (id, workspace_id, slug, name, kind, created_by_user_id)
         VALUES ($1, $1, $2, $3, 'organization', $4)`,
        [workspaceId, slug, name, session.actorId],
      );
      await client.query(
        `INSERT INTO workspace_memberships
           (id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'owner')`,
        [id("membership"), workspaceId, session.actorId],
      );
      await client.query(
        `INSERT INTO workspace_placements
           (workspace_id, region_id, epoch, state)
         VALUES ($1, $2, 1, 'active')`,
        [workspaceId, homeRegionId],
      );
      await client.query(
        `INSERT INTO resource_routing_directory
           (resource_type, resource_id, workspace_id, state)
         VALUES ('workspace', $1, $1, 'active')`,
        [workspaceId],
      );
      await writeControlPlaneAudit(client, {
        workspaceId,
        eventType: "workspace.created",
        action: "workspace:write",
        outcome: "success",
        actorType: "user",
        actorId: session.actorId,
        userId: session.actorId,
        requestId: context.get("requestId"),
        resourceType: "workspace",
        resourceId: workspaceId,
        channel: "app",
        retentionClass: "permanent",
        metadata: { kind: "organization", homeRegionId, placementEpoch: 1 },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (
        isPostgresUniqueViolation(error, "workspaces_slug_unique") ||
        isPostgresUniqueViolation(error, "workspaces_slug_key")
      ) {
        throw new DomainError(
          "WORKSPACE_SLUG_CONFLICT",
          "That workspace URL is already in use",
          409,
          { field: "slug" },
        );
      }
      throw error;
    } finally {
      client.release();
    }
    return context.json(
      success(context, {
        workspace: {
          id: workspaceId,
          kind: "organization",
          name,
          slug,
          role: "owner",
        },
      }),
      201,
    );
  });

  app.patch("/api/v1/workspaces/:workspaceId", async (context) => {
    const services = context.get("services");
    if (!services)
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    const principal = await workspaceUser(context);
    authorize(principal, "workspace:update");
    const body = await readJsonObject(context);
    const updates: string[] = [];
    const values: unknown[] = [];
    if (body.name !== undefined) {
      updates.push(`name = $${String(values.length + 1)}`);
      values.push(normalizeWorkspaceName(body.name));
    }
    if (body.slug !== undefined) {
      updates.push(`slug = $${String(values.length + 1)}`);
      values.push(normalizeWorkspaceSlug(body.slug));
    }
    if (updates.length === 0) {
      throw new DomainError(
        "VALIDATION_FAILED",
        "No workspace changes were supplied",
        400,
      );
    }
    values.push(principal.workspaceId);
    try {
      const result = await services.controlDatabase.pool.query<{
        id: string;
        kind: string;
        slug: string;
        name: string;
        updated_at: Date;
      }>(
        `UPDATE workspaces
            SET ${updates.join(", ")}, updated_at = now()
          WHERE id = $${String(values.length)}
          RETURNING id, kind, slug, name, updated_at`,
        values,
      );
      const row = result.rows[0];
      if (!row) throw new DomainError("NOT_FOUND", "Workspace was not found", 404);
      return context.json(
        success(context, {
          workspace: {
            id: row.id,
            kind: row.kind,
            slug: row.slug,
            name: row.name,
            updatedAt: row.updated_at.toISOString(),
          },
        }),
      );
    } catch (error) {
      if (
        isPostgresUniqueViolation(error, "workspaces_slug_unique") ||
        isPostgresUniqueViolation(error, "workspaces_slug_key")
      ) {
        throw new DomainError(
          "WORKSPACE_SLUG_CONFLICT",
          "That workspace URL is already in use",
          409,
          { field: "slug" },
        );
      }
      throw error;
    }
  });

  app.get("/api/v1/workspaces/:workspaceId/members", async (context) => {
    const services = context.get("services");
    if (!services)
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    const principal = await workspaceUser(context);
    authorize(principal, "members:read");
    const result = await services.controlDatabase.pool.query<{
      user_id: string;
      role: string;
      email: string | null;
      display_name: string | null;
      created_at: Date;
    }>(
      `SELECT m.user_id, m.role, u.primary_email AS email,
              u.metadata->>'displayName' AS display_name, m.created_at
         FROM workspace_memberships m
         JOIN authfn_users u ON u.id = m.user_id
        WHERE m.workspace_id = $1
        ORDER BY CASE m.role
          WHEN 'owner' THEN 0 WHEN 'admin' THEN 1
          WHEN 'editor' THEN 2 ELSE 3 END, m.created_at, m.id`,
      [principal.workspaceId],
    );
    return context.json(
      success(context, {
        members: result.rows.map((row) => ({
          userId: row.user_id,
          role: row.role,
          email: row.email,
          displayName: row.display_name,
          joinedAt: row.created_at.toISOString(),
        })),
      }),
    );
  });

  app.patch("/api/v1/workspaces/:workspaceId/members/:userId", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const body = await readJsonObject(context);
    const nextRole = parseWorkspaceRole(body.role, { allowOwner: true });
    const client = await services.controlDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await lockWorkspaceMemberships(
        client,
        context.req.param("workspaceId"),
      );
      const actorRole = membershipRole(rows, session.actorId);
      const targetRole = membershipRole(rows, context.req.param("userId"));
      assertMembershipChange(actorRole, targetRole, nextRole);
      assertOwnerRemains(
        rows.filter((row) => row.role === "owner").length,
        targetRole === "owner" && nextRole !== "owner",
      );
      await client.query(
        `UPDATE workspace_memberships
              SET role = $1, updated_at = now()
            WHERE workspace_id = $2 AND user_id = $3`,
        [nextRole, context.req.param("workspaceId"), context.req.param("userId")],
      );
      await writeControlPlaneAudit(client, {
        workspaceId: context.req.param("workspaceId"),
        eventType: "workspace.membership.role_changed",
        action: "members:write",
        outcome: "success",
        actorType: "user",
        actorId: session.actorId,
        userId: session.actorId,
        requestId: context.get("requestId"),
        resourceType: "workspace_membership",
        resourceId: context.req.param("userId"),
        channel: "app",
        retentionClass: "permanent",
        metadata: {
          targetUserId: context.req.param("userId"),
          previousRole: targetRole,
          nextRole,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return context.json(success(context, { role: nextRole }));
  });

  app.delete("/api/v1/workspaces/:workspaceId/members/:userId", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const client = await services.controlDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await lockWorkspaceMemberships(
        client,
        context.req.param("workspaceId"),
      );
      const actorRole = membershipRole(rows, session.actorId);
      const targetRole = membershipRole(rows, context.req.param("userId"));
      assertMembershipChange(actorRole, targetRole);
      assertOwnerRemains(
        rows.filter((row) => row.role === "owner").length,
        targetRole === "owner",
      );
      await client.query(
        "DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
        [context.req.param("workspaceId"), context.req.param("userId")],
      );
      await writeControlPlaneAudit(client, {
        workspaceId: context.req.param("workspaceId"),
        eventType: "workspace.membership.removed",
        action: "members:write",
        outcome: "success",
        actorType: "user",
        actorId: session.actorId,
        userId: session.actorId,
        requestId: context.get("requestId"),
        resourceType: "workspace_membership",
        resourceId: context.req.param("userId"),
        channel: "app",
        retentionClass: "permanent",
        metadata: {
          targetUserId: context.req.param("userId"),
          previousRole: targetRole,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return context.json(success(context, { removed: true }));
  });

  app.post("/api/v1/workspaces/:workspaceId/leave", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const client = await services.controlDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      const rows = await lockWorkspaceMemberships(
        client,
        context.req.param("workspaceId"),
      );
      const targetRole = membershipRole(rows, session.actorId);
      assertOwnerRemains(
        rows.filter((row) => row.role === "owner").length,
        targetRole === "owner",
      );
      await client.query(
        "DELETE FROM workspace_memberships WHERE workspace_id = $1 AND user_id = $2",
        [context.req.param("workspaceId"), session.actorId],
      );
      await writeControlPlaneAudit(client, {
        workspaceId: context.req.param("workspaceId"),
        eventType: "workspace.membership.left",
        action: "members:write",
        outcome: "success",
        actorType: "user",
        actorId: session.actorId,
        userId: session.actorId,
        requestId: context.get("requestId"),
        resourceType: "workspace_membership",
        resourceId: session.actorId,
        channel: "app",
        retentionClass: "permanent",
        metadata: { previousRole: targetRole },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return context.json(success(context, { left: true }));
  });
}
