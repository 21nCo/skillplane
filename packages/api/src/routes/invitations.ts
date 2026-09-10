import {
  DomainError,
  assertInvitationAcceptable,
  authorize,
  invitationExpiry,
  normalizeInvitationEmail,
  parseInvitationRole,
} from "@skillplane/domain";
import { renderInvitationEmail } from "@skillplane/email";
import type { Hono } from "hono";
import {
  writeControlPlaneAudit,
  writePrincipalControlPlaneAudit,
} from "../control-audit.js";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import {
  createOpaqueToken,
  decryptEmail,
  encryptEmail,
  hashEmail,
  hashOpaqueToken,
} from "../tenancy-crypto.js";
import { isPostgresUniqueViolation, readJsonObject, workspaceUser } from "./shared.js";

interface InvitationRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly workspace_name: string;
  readonly email_hash: string;
  readonly email_ciphertext: string;
  readonly role: string;
  readonly expires_at: Date;
  readonly accepted_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
}

function invitationId(): string {
  return `invitation:${crypto.randomUUID()}`;
}

export function registerInvitationRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/workspaces/:workspaceId/invitations", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const principal = await workspaceUser(context);
    authorize(principal, "members:read");
    const result = await services.controlDatabase.pool.query<InvitationRow>(
      `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email_hash,
                i.email_ciphertext, i.role, i.expires_at, i.accepted_at,
                i.revoked_at, i.created_at
           FROM workspace_invitations i
           JOIN workspaces w ON w.id = i.workspace_id
          WHERE i.workspace_id = $1
          ORDER BY i.created_at DESC, i.id`,
      [principal.workspaceId],
    );
    const invitations = await Promise.all(
      result.rows.map(async (row) => ({
        id: row.id,
        email: await decryptEmail(services.tenancySecret, row.email_ciphertext),
        role: row.role,
        expiresAt: row.expires_at.toISOString(),
        acceptedAt: row.accepted_at?.toISOString() ?? null,
        revokedAt: row.revoked_at?.toISOString() ?? null,
        createdAt: row.created_at.toISOString(),
      })),
    );
    return context.json(success(context, { invitations }));
  });

  app.post("/api/v1/workspaces/:workspaceId/invitations", async (context) => {
    const services = context.get("services");
    if (!services) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    if (!services.email) {
      throw new DomainError(
        "CONFLICT",
        "Invitation email delivery is unavailable",
        409,
      );
    }
    const principal = await workspaceUser(context);
    authorize(principal, "members:write");
    const body = await readJsonObject(context);
    const email = normalizeInvitationEmail(body.email);
    const role = parseInvitationRole(body.role);
    const workspace = await services.controlDatabase.pool.query<{
      name: string;
      kind: string;
    }>("SELECT name, kind FROM workspaces WHERE id = $1", [principal.workspaceId]);
    const workspaceRow = workspace.rows[0];
    if (!workspaceRow) {
      throw new DomainError("NOT_FOUND", "Workspace was not found", 404);
    }
    if (workspaceRow.kind !== "organization") {
      throw new DomainError(
        "WORKSPACE_FORBIDDEN",
        "Personal workspaces cannot invite members",
        403,
      );
    }
    const token = createOpaqueToken("spi");
    const id = invitationId();
    const emailLookup = await hashEmail(services.tenancySecret, email);
    const membership = await services.controlDatabase.pool.query(
      `SELECT 1
           FROM workspace_memberships m
           JOIN authfn_users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND u.primary_email = $2
          LIMIT 1`,
      [principal.workspaceId, email],
    );
    if (membership.rowCount) {
      throw new DomainError(
        "CONFLICT",
        "This person is already a workspace member",
        409,
        { field: "email" },
      );
    }
    await services.controlDatabase.pool.query(
      `UPDATE workspace_invitations
            SET revoked_at = now()
          WHERE workspace_id = $1 AND email_hash = $2
            AND accepted_at IS NULL AND revoked_at IS NULL
            AND expires_at <= now()`,
      [principal.workspaceId, emailLookup],
    );
    const duplicate = await services.controlDatabase.pool.query(
      `SELECT 1 FROM workspace_invitations
          WHERE workspace_id = $1 AND email_hash = $2
            AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
          LIMIT 1`,
      [principal.workspaceId, emailLookup],
    );
    if (duplicate.rowCount) {
      throw new DomainError(
        "CONFLICT",
        "An active invitation already exists for this recipient",
        409,
      );
    }
    const expiresAt = invitationExpiry();
    const client = await services.controlDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO workspace_invitations
           (id, workspace_id, email_hash, email_ciphertext, role, token_hash,
            invited_by_user_id, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          principal.workspaceId,
          emailLookup,
          await encryptEmail(services.tenancySecret, email),
          role,
          await hashOpaqueToken(token),
          principal.userId,
          expiresAt,
        ],
      );
      await writePrincipalControlPlaneAudit(client, principal, {
        eventType: "workspace.invitation.created",
        action: "members:write",
        requestId: context.get("requestId"),
        resourceType: "workspace_invitation",
        resourceId: id,
        metadata: { role, expiresAt: expiresAt.toISOString() },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        isPostgresUniqueViolation(error, "workspace_invitations_active_email_unique")
      ) {
        throw new DomainError(
          "CONFLICT",
          "An active invitation already exists for this recipient",
          409,
        );
      }
      throw error;
    } finally {
      client.release();
    }
    const invitationUrl = new URL(
      `/invitations/${encodeURIComponent(token)}`,
      context.req.url,
    ).toString();
    const rendered = renderInvitationEmail({
      inviterName: principal.displayName ?? principal.email ?? "A workspace owner",
      workspaceName: workspaceRow.name,
      invitationUrl,
      expiresInHours: 7 * 24,
    });
    try {
      const delivery = await services.email.client.email({
        userId: principal.userId,
        to: email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        metadata: {
          invitationId: id,
          workspaceId: principal.workspaceId,
        },
        tags: ["workspace", "invitation"],
      });
      return context.json(
        success(context, {
          invitation: {
            id,
            email,
            role,
            expiresAt: expiresAt.toISOString(),
            acceptedAt: null,
            revokedAt: null,
          },
          delivery: {
            provider: delivery.provider,
            transactionId: delivery.id,
            sentAt: delivery.sentAt?.toISOString() ?? null,
          },
        }),
        201,
      );
    } catch (error) {
      await services.controlDatabase.pool.query(
        "DELETE FROM workspace_invitations WHERE id = $1 AND accepted_at IS NULL",
        [id],
      );
      throw error;
    }
  });

  app.delete(
    "/api/v1/workspaces/:workspaceId/invitations/:invitationId",
    async (context) => {
      const services = context.get("services");
      if (!services) {
        throw new DomainError(
          "AUTHENTICATION_REQUIRED",
          "Authentication is required",
          401,
        );
      }
      const principal = await workspaceUser(context);
      authorize(principal, "members:write");
      const client = await services.controlDatabase.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE workspace_invitations
            SET revoked_at = now()
          WHERE id = $1 AND workspace_id = $2
            AND accepted_at IS NULL AND revoked_at IS NULL
          RETURNING id`,
          [context.req.param("invitationId"), principal.workspaceId],
        );
        if (!result.rowCount) {
          throw new DomainError(
            "INVITATION_INVALID",
            "The invitation is not available",
            404,
          );
        }
        await writePrincipalControlPlaneAudit(client, principal, {
          eventType: "workspace.invitation.revoked",
          action: "members:write",
          requestId: context.get("requestId"),
          resourceType: "workspace_invitation",
          resourceId: context.req.param("invitationId"),
        });
        await client.query("COMMIT");
        return context.json(success(context, { revoked: true }));
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.get("/api/v1/invitations/:token", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const result = await services.controlDatabase.pool.query<InvitationRow>(
      `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email_hash,
              i.email_ciphertext, i.role, i.expires_at, i.accepted_at,
              i.revoked_at, i.created_at
         FROM workspace_invitations i
         JOIN workspaces w ON w.id = i.workspace_id
        WHERE i.token_hash = $1
        LIMIT 1`,
      [await hashOpaqueToken(context.req.param("token"))],
    );
    const row = result.rows[0];
    if (!row) {
      throw new DomainError(
        "INVITATION_INVALID",
        "The invitation is not available",
        404,
      );
    }
    const email = normalizeInvitationEmail(
      session.subject.email ??
        (
          await services.controlDatabase.pool.query<{ primary_email: string | null }>(
            "SELECT primary_email FROM authfn_users WHERE id = $1",
            [session.actorId],
          )
        ).rows[0]?.primary_email,
    );
    assertInvitationAcceptable({
      acceptedAt: row.accepted_at,
      expiresAt: row.expires_at,
      revokedAt: row.revoked_at,
      emailMatches: (await hashEmail(services.tenancySecret, email)) === row.email_hash,
    });
    return context.json(
      success(context, {
        invitation: {
          workspaceId: row.workspace_id,
          workspaceName: row.workspace_name,
          role: row.role,
          expiresAt: row.expires_at.toISOString(),
        },
      }),
    );
  });

  app.post("/api/v1/invitations/:token/accept", async (context) => {
    const services = context.get("services");
    const session = context.get("session");
    if (!services || !session) {
      throw new DomainError(
        "AUTHENTICATION_REQUIRED",
        "Authentication is required",
        401,
      );
    }
    const tokenHash = await hashOpaqueToken(context.req.param("token"));
    const client = await services.controlDatabase.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<InvitationRow>(
        `SELECT i.id, i.workspace_id, w.name AS workspace_name, i.email_hash,
                i.email_ciphertext, i.role, i.expires_at, i.accepted_at,
                i.revoked_at, i.created_at
           FROM workspace_invitations i
           JOIN workspaces w ON w.id = i.workspace_id
          WHERE i.token_hash = $1
          FOR UPDATE OF i`,
        [tokenHash],
      );
      const row = result.rows[0];
      if (!row) {
        throw new DomainError(
          "INVITATION_INVALID",
          "The invitation is not available",
          404,
        );
      }
      const email = normalizeInvitationEmail(
        session.subject.email ??
          (
            await client.query<{ primary_email: string | null }>(
              "SELECT primary_email FROM authfn_users WHERE id = $1",
              [session.actorId],
            )
          ).rows[0]?.primary_email,
      );
      assertInvitationAcceptable({
        acceptedAt: row.accepted_at,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
        emailMatches:
          (await hashEmail(services.tenancySecret, email)) === row.email_hash,
      });
      await client.query(
        `INSERT INTO workspace_memberships
           (id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (workspace_id, user_id) DO NOTHING`,
        [
          `membership:${crypto.randomUUID()}`,
          row.workspace_id,
          session.actorId,
          row.role,
        ],
      );
      await client.query(
        `UPDATE workspace_invitations
            SET accepted_at = now(), accepted_by_user_id = $1
          WHERE id = $2`,
        [session.actorId, row.id],
      );
      await writeControlPlaneAudit(client, {
        workspaceId: row.workspace_id,
        eventType: "workspace.invitation.accepted",
        action: "members:write",
        outcome: "success",
        actorType: "user",
        actorId: session.actorId,
        userId: session.actorId,
        requestId: context.get("requestId"),
        resourceType: "workspace_invitation",
        resourceId: row.id,
        channel: "app",
        retentionClass: "permanent",
        metadata: { role: row.role },
      });
      await client.query("COMMIT");
      return context.json(
        success(context, {
          accepted: true,
          workspace: {
            id: row.workspace_id,
            name: row.workspace_name,
            role: row.role,
          },
        }),
      );
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
