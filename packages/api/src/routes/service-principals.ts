import {
  DomainError,
  authorize,
  normalizeServicePrincipalName,
  parseServicePrincipalRole,
  parseServicePrincipalScopes,
} from "@skillplane/domain";
import type { Hono } from "hono";
import {
  writeControlPlaneAudit,
  writePrincipalControlPlaneAudit,
} from "../control-audit.js";
import type { ApiEnvironment, ApiServices } from "../context.js";
import { success } from "../envelopes.js";
import {
  isPostgresUniqueViolation,
  parseOptionalExpiry,
  readJsonObject,
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
  readonly authfn_api_key_id: string | null;
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
    credentialAvailable: Boolean(row.authfn_api_key_id),
    lastUsedAt: row.last_used_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function credentialMetadata(input: {
  readonly servicePrincipalId: string;
  readonly workspaceId: string;
  readonly credentialVersion: number;
}): Readonly<Record<string, unknown>> {
  return {
    kind: "skillplane_service_principal",
    servicePrincipalId: input.servicePrincipalId,
    workspaceId: input.workspaceId,
    credentialVersion: input.credentialVersion,
  };
}

async function issueAuthFnCredential(
  services: ApiServices,
  input: {
    readonly ownerUserId: string;
    readonly servicePrincipalId: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly scopes: readonly string[];
    readonly expiresAt: Date | null;
    readonly credentialVersion: number;
    readonly requestId: string;
  },
) {
  return services.auth.apiKeys.create({
    ownerUserId: input.ownerUserId,
    name: `Skillplane agent: ${input.name}`,
    scopes: input.scopes,
    metadata: credentialMetadata(input),
    expiresAt: input.expiresAt,
    requestId: input.requestId,
  });
}

async function revokeAuthFnCredentialBestEffort(
  services: ApiServices,
  input: {
    readonly keyId: string;
    readonly actorId: string;
    readonly workspaceId: string;
    readonly servicePrincipalId: string;
    readonly requestId: string;
    readonly reason: "rollback" | "rotation" | "revocation";
  },
): Promise<void> {
  try {
    await services.auth.apiKeys.revoke(input);
  } catch {
    let auditRecorded = false;
    try {
      await writeControlPlaneAudit(services.controlDatabase.pool, {
        workspaceId: input.workspaceId,
        eventType: "service_principal.authfn_key_cleanup_failed",
        action: "members:write",
        outcome: "error",
        actorType: "user",
        actorId: input.actorId,
        userId: input.actorId,
        requestId: input.requestId,
        resourceType: "service_principal",
        resourceId: input.servicePrincipalId,
        errorCode: "AUTHFN_KEY_CLEANUP_FAILED",
        metadata: {
          credentialId: input.keyId,
          cleanupReason: input.reason,
        },
      });
      auditRecorded = true;
    } catch {
      // The structured error below remains the alertable fallback if audit storage fails.
    }
    console.error(
      JSON.stringify({
        component: "api",
        event: "service_principal.authfn_key_cleanup.failed",
        keyId: input.keyId,
        requestId: input.requestId,
        reason: input.reason,
        auditRecorded,
      }),
    );
  }
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
    const result = await services.controlDatabase.pool.query<ServicePrincipalRow>(
      `SELECT id, name, role, scopes, delegated_user_id, expires_at,
                credential_version, authfn_api_key_id,
                last_used_at, revoked_at, created_at, updated_at
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
      const membership = await services.controlDatabase.pool.query(
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
    const id = `service-principal:${crypto.randomUUID()}`;
    const requestId = context.get("requestId");
    const issued = await issueAuthFnCredential(services, {
      ownerUserId: principal.userId,
      servicePrincipalId: id,
      workspaceId: principal.workspaceId,
      name,
      scopes,
      expiresAt,
      credentialVersion: 1,
      requestId,
    });
    const client = await services.controlDatabase.pool
      .connect()
      .catch(async (error: unknown) => {
        await revokeAuthFnCredentialBestEffort(services, {
          keyId: issued.keyId,
          actorId: principal.userId,
          workspaceId: principal.workspaceId,
          servicePrincipalId: id,
          requestId,
          reason: "rollback",
        });
        throw error;
      });
    let clientReleased = false;
    const releaseClient = () => {
      if (clientReleased) return;
      client.release();
      clientReleased = true;
    };
    try {
      await client.query("BEGIN");
      const result = await client.query<ServicePrincipalRow>(
        `INSERT INTO service_principals
             (id, workspace_id, name, role, scopes, authfn_api_key_id,
              created_by_user_id, delegated_user_id, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           RETURNING id, name, role, scopes, delegated_user_id, expires_at,
                     credential_version, authfn_api_key_id,
                     last_used_at, revoked_at, created_at, updated_at`,
        [
          id,
          principal.workspaceId,
          name,
          role,
          scopes,
          issued.keyId,
          principal.userId,
          delegatedUserId,
          expiresAt,
        ],
      );
      const created = result.rows[0];
      if (!created) throw new Error("Service principal insert returned no row");
      await writePrincipalControlPlaneAudit(client, principal, {
        eventType: "service_principal.created",
        action: "members:write",
        requestId,
        resourceType: "service_principal",
        resourceId: id,
        metadata: {
          role,
          scopes,
          delegated: Boolean(delegatedUserId),
          expires: Boolean(expiresAt),
          credentialId: issued.keyId,
        },
      });
      await client.query("COMMIT");
      return context.json(
        success(context, {
          servicePrincipal: serialize(created),
          credential: issued.secret,
        }),
        201,
      );
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      releaseClient();
      await revokeAuthFnCredentialBestEffort(services, {
        keyId: issued.keyId,
        actorId: principal.userId,
        workspaceId: principal.workspaceId,
        servicePrincipalId: id,
        requestId,
        reason: "rollback",
      });
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
      releaseClient();
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
      const servicePrincipalId = context.req.param("servicePrincipalId");
      const requestId = context.get("requestId");
      const snapshotResult =
        await services.controlDatabase.pool.query<ServicePrincipalRow>(
          `SELECT id, name, role, scopes, delegated_user_id, expires_at,
                credential_version, authfn_api_key_id,
                last_used_at, revoked_at, created_at, updated_at
           FROM service_principals
          WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL`,
          [principal.workspaceId, servicePrincipalId],
        );
      const snapshot = snapshotResult.rows[0];
      if (!snapshot) {
        throw new DomainError(
          "SERVICE_PRINCIPAL_INVALID",
          "The service principal is not active",
          404,
        );
      }
      const nextVersion = snapshot.credential_version + 1;
      const nextExpiry = expiresAt === undefined ? snapshot.expires_at : expiresAt;
      const issued = await issueAuthFnCredential(services, {
        ownerUserId: principal.userId,
        servicePrincipalId,
        workspaceId: principal.workspaceId,
        name: snapshot.name,
        scopes: snapshot.scopes,
        expiresAt: nextExpiry,
        credentialVersion: nextVersion,
        requestId,
      });
      const client = await services.controlDatabase.pool
        .connect()
        .catch(async (error: unknown) => {
          await revokeAuthFnCredentialBestEffort(services, {
            keyId: issued.keyId,
            actorId: principal.userId,
            workspaceId: principal.workspaceId,
            servicePrincipalId,
            requestId,
            reason: "rollback",
          });
          throw error;
        });
      let clientReleased = false;
      const releaseClient = () => {
        if (clientReleased) return;
        client.release();
        clientReleased = true;
      };
      let previousAuthFnKeyId: string | null;
      let row: ServicePrincipalRow;
      try {
        await client.query("BEGIN");
        const currentResult = await client.query<ServicePrincipalRow>(
          `SELECT id, name, role, scopes, delegated_user_id, expires_at,
                  credential_version, authfn_api_key_id,
                  last_used_at, revoked_at, created_at, updated_at
             FROM service_principals
            WHERE workspace_id = $1 AND id = $2 AND revoked_at IS NULL
            FOR UPDATE`,
          [principal.workspaceId, servicePrincipalId],
        );
        const current = currentResult.rows[0];
        if (!current) {
          throw new DomainError(
            "SERVICE_PRINCIPAL_INVALID",
            "The service principal is not active",
            404,
          );
        }
        if (
          current.credential_version !== snapshot.credential_version ||
          current.authfn_api_key_id !== snapshot.authfn_api_key_id
        ) {
          throw new DomainError(
            "CONFLICT",
            "The service principal credential changed during rotation",
            409,
          );
        }
        const result = await client.query<ServicePrincipalRow>(
          `UPDATE service_principals
              SET authfn_api_key_id = $1,
                  credential_version = credential_version + 1,
                  last_used_at = NULL,
                  expires_at = $4,
                  updated_at = now()
            WHERE workspace_id = $2 AND id = $3 AND revoked_at IS NULL
            RETURNING id, name, role, scopes, delegated_user_id, expires_at,
                      credential_version, authfn_api_key_id,
                      last_used_at, revoked_at, created_at, updated_at`,
          [issued.keyId, principal.workspaceId, servicePrincipalId, nextExpiry],
        );
        const updated = result.rows[0];
        if (!updated) {
          throw new DomainError(
            "SERVICE_PRINCIPAL_INVALID",
            "The service principal is not active",
            404,
          );
        }
        await writePrincipalControlPlaneAudit(client, principal, {
          eventType: "service_principal.credential_rotated",
          action: "members:write",
          requestId,
          resourceType: "service_principal",
          resourceId: updated.id,
          metadata: {
            credentialVersion: updated.credential_version,
            expires: Boolean(updated.expires_at),
            credentialId: issued.keyId,
          },
        });
        await client.query("COMMIT");
        previousAuthFnKeyId = current.authfn_api_key_id;
        row = updated;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        releaseClient();
        await revokeAuthFnCredentialBestEffort(services, {
          keyId: issued.keyId,
          actorId: principal.userId,
          workspaceId: principal.workspaceId,
          servicePrincipalId,
          requestId,
          reason: "rollback",
        });
        throw error;
      } finally {
        releaseClient();
      }
      if (previousAuthFnKeyId) {
        await revokeAuthFnCredentialBestEffort(services, {
          keyId: previousAuthFnKeyId,
          actorId: principal.userId,
          workspaceId: principal.workspaceId,
          servicePrincipalId,
          requestId,
          reason: "rotation",
        });
      }
      return context.json(
        success(context, {
          servicePrincipal: serialize(row),
          credential: issued.secret,
        }),
      );
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
      const servicePrincipalId = context.req.param("servicePrincipalId");
      const requestId = context.get("requestId");
      const client = await services.controlDatabase.pool.connect();
      let authFnKeyId: string | null;
      try {
        await client.query("BEGIN");
        const current = await client.query<{ authfn_api_key_id: string | null }>(
          `SELECT authfn_api_key_id
             FROM service_principals
            WHERE workspace_id = $1 AND id = $2
            FOR UPDATE`,
          [principal.workspaceId, servicePrincipalId],
        );
        const currentRow = current.rows[0];
        if (!currentRow) {
          throw new DomainError(
            "SERVICE_PRINCIPAL_INVALID",
            "The service principal was not found",
            404,
          );
        }
        const result = await client.query(
          `UPDATE service_principals
            SET revoked_at = COALESCE(revoked_at, now()), updated_at = now()
          WHERE workspace_id = $1 AND id = $2
          RETURNING id`,
          [principal.workspaceId, servicePrincipalId],
        );
        if (!result.rowCount) {
          throw new DomainError(
            "SERVICE_PRINCIPAL_INVALID",
            "The service principal was not found",
            404,
          );
        }
        await writePrincipalControlPlaneAudit(client, principal, {
          eventType: "service_principal.revoked",
          action: "members:write",
          requestId,
          resourceType: "service_principal",
          resourceId: servicePrincipalId,
          metadata: {
            credentialAvailable: Boolean(currentRow.authfn_api_key_id),
            ...(currentRow.authfn_api_key_id
              ? { credentialId: currentRow.authfn_api_key_id }
              : {}),
          },
        });
        await client.query("COMMIT");
        authFnKeyId = currentRow.authfn_api_key_id;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
      if (authFnKeyId) {
        await revokeAuthFnCredentialBestEffort(services, {
          keyId: authFnKeyId,
          actorId: principal.userId,
          workspaceId: principal.workspaceId,
          servicePrincipalId,
          requestId,
          reason: "revocation",
        });
      }
      return context.json(success(context, { revoked: true }));
    },
  );
}
