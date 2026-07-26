import {
  DomainError,
  authorize,
  normalizeServicePrincipalName,
  parseServicePrincipalRole,
  parseServicePrincipalScopes,
} from "@skillplane/domain";
import type { Hono } from "hono";
import type { ApiEnvironment } from "../context.js";
import { success } from "../envelopes.js";
import { createOpaqueToken, hashOpaqueToken } from "../tenancy-crypto.js";
import {
  isPostgresUniqueViolation,
  parseOptionalExpiry,
  readJsonObject,
  writeApiAudit,
  workspaceUser,
} from "./shared.js";

interface ServicePrincipalRow {
  readonly id: string;
  readonly name: string;
  readonly role: string;
  readonly scopes: string[];
  readonly delegated_user_id: string | null;
  readonly expires_at: Date | null;
  readonly credential_version: number;
  readonly last_used_at: Date | null;
  readonly revoked_at: Date | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function serialize(row: ServicePrincipalRow) {
  return {
    id: row.id,
    name: row.name,
    role: row.role,
    scopes: row.scopes,
    delegatedUserId: row.delegated_user_id,
    expiresAt: row.expires_at?.toISOString() ?? null,
    credentialVersion: row.credential_version,
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function registerServicePrincipalRoutes(app: Hono<ApiEnvironment>): void {
  app.get("/api/v1/workspaces/:workspaceId/service-principals", async (context) => {
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
    const result = await services.database.pool.query<ServicePrincipalRow>(
      `SELECT id, name, role, scopes, delegated_user_id, expires_at,
                credential_version, last_used_at, revoked_at, created_at, updated_at
           FROM service_principals
          WHERE workspace_id = $1
          ORDER BY created_at DESC, id`,
      [principal.workspaceId],
    );
    return context.json(
      success(context, { servicePrincipals: result.rows.map(serialize) }),
    );
  });

  app.post("/api/v1/workspaces/:workspaceId/service-principals", async (context) => {
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
    const body = await readJsonObject(context);
    const name = normalizeServicePrincipalName(body.name);
    const role = parseServicePrincipalRole(body.role);
    const scopes = parseServicePrincipalScopes(body.scopes);
    const expiresAt = parseOptionalExpiry(body.expiresAt);
    const delegatedUserId =
      body.delegatedUserId === null ||
      body.delegatedUserId === undefined ||
      body.delegatedUserId === ""
        ? null
        : typeof body.delegatedUserId === "string"
          ? body.delegatedUserId
          : (() => {
              throw new DomainError(
                "VALIDATION_FAILED",
                "Delegated identity must be a user ID",
                400,
                { field: "delegatedUserId" },
              );
            })();
    if (delegatedUserId) {
      const membership = await services.database.pool.query(
        `SELECT 1 FROM workspace_memberships
            WHERE workspace_id = $1 AND user_id = $2`,
        [principal.workspaceId, delegatedUserId],
      );
      if (!membership.rowCount) {
        throw new DomainError(
          "VALIDATION_FAILED",
          "Delegated identity must be a workspace member",
          400,
          { field: "delegatedUserId" },
        );
      }
    }
    const credential = createOpaqueToken("sps");
    const id = `service-principal:${crypto.randomUUID()}`;
    const client = await services.database.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<ServicePrincipalRow>(
        `INSERT INTO service_principals
             (id, workspace_id, name, role, scopes, credential_hash,
              created_by_user_id, delegated_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, name, role, scopes, delegated_user_id, expires_at,
                     credential_version, last_used_at, revoked_at, created_at,
                     updated_at`,
        [
          id,
          principal.workspaceId,
          name,
          role,
          scopes,
          await hashOpaqueToken(credential),
          principal.userId,
          delegatedUserId,
          expiresAt,
        ],
      );
      const created = result.rows[0];
      if (!created) throw new Error("Service principal insert returned no row");
      await writeApiAudit(client, principal, {
        eventType: "service_principal.created",
        action: "members:write",
        requestId: context.get("requestId"),
        resourceType: "service_principal",
        resourceId: id,
        metadata: {
          role,
          scopes,
          delegated: Boolean(delegatedUserId),
          expires: Boolean(expiresAt),
        },
      });
      await client.query("COMMIT");
      return context.json(
        success(context, {
          servicePrincipal: serialize(created),
          credential,
        }),
        201,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (
        isPostgresUniqueViolation(error, "service_principals_workspace_name_unique")
      ) {
        throw new DomainError(
          "CONFLICT",
          "A service principal with that name already exists",
          409,
          { field: "name" },
        );
      }
      throw error;
    } finally {
      client.release();
    }
  });

  app.post(
    "/api/v1/workspaces/:workspaceId/service-principals/:servicePrincipalId/rotate",
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
      const body = await readJsonObject(context);
      const expiresAt =
        body.expiresAt === undefined ? undefined : parseOptionalExpiry(body.expiresAt);
      const credential = createOpaqueToken("sps");
      const values: unknown[] = [
        await hashOpaqueToken(credential),
        principal.workspaceId,
        context.req.param("servicePrincipalId"),
      ];
      const expirySql =
        expiresAt === undefined
          ? ""
          : `, expires_at = $${String(values.push(expiresAt))}`;
      const client = await services.database.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query<ServicePrincipalRow>(
          `UPDATE service_principals
            SET credential_hash = $1,
                credential_version = credential_version + 1,
                last_used_at = NULL,
                updated_at = now()
                ${expirySql}
          WHERE workspace_id = $2 AND id = $3 AND revoked_at IS NULL
          RETURNING id, name, role, scopes, delegated_user_id, expires_at,
                    credential_version, last_used_at, revoked_at, created_at,
                    updated_at`,
          values,
        );
        const row = result.rows[0];
        if (!row) {
          throw new DomainError(
            "SERVICE_PRINCIPAL_INVALID",
            "The service principal is not active",
            404,
          );
        }
        await writeApiAudit(client, principal, {
          eventType: "service_principal.credential_rotated",
          action: "members:write",
          requestId: context.get("requestId"),
          resourceType: "service_principal",
          resourceId: row.id,
          metadata: {
            credentialVersion: row.credential_version,
            expires: Boolean(row.expires_at),
          },
        });
        await client.query("COMMIT");
        return context.json(
          success(context, {
            servicePrincipal: serialize(row),
            credential,
          }),
        );
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  app.delete(
    "/api/v1/workspaces/:workspaceId/service-principals/:servicePrincipalId",
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
      const client = await services.database.pool.connect();
      try {
        await client.query("BEGIN");
        const result = await client.query(
          `UPDATE service_principals
            SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING id`,
          [principal.workspaceId, context.req.param("servicePrincipalId")],
        );
        if (!result.rowCount) {
          throw new DomainError(
            "SERVICE_PRINCIPAL_INVALID",
            "The service principal was not found",
            404,
          );
        }
        await writeApiAudit(client, principal, {
          eventType: "service_principal.revoked",
          action: "members:write",
          requestId: context.get("requestId"),
          resourceType: "service_principal",
          resourceId: context.req.param("servicePrincipalId"),
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
}
