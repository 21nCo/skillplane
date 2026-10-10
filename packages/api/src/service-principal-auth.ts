import { AuthFnApiKeyRevokedError } from "authfn";
import {
  InvalidAuthenticationError,
  SERVICE_PRINCIPAL_SCOPES,
  isWorkspaceRole,
  type ServicePrincipal,
  type ServicePrincipalScope,
} from "@skillplane/domain";
import type { ApiServices } from "./context.js";

export interface AuthenticatedServicePrincipal {
  readonly principal: ServicePrincipal;
  readonly credentialId: string;
  readonly credentialKind: "service_principal";
}

interface ServicePrincipalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly role: string;
  readonly scopes: string[];
  readonly delegated_user_id: string | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
  readonly credential_version: number;
  readonly authfn_api_key_id: string | null;
}

function servicePrincipal(row: ServicePrincipalRow): ServicePrincipal {
  const scopes = row.scopes.filter((scope): scope is ServicePrincipalScope =>
    (SERVICE_PRINCIPAL_SCOPES as readonly string[]).includes(scope),
  );
  if (
    !isWorkspaceRole(row.role) ||
    row.role === "owner" ||
    scopes.length !== row.scopes.length
  ) {
    throw new InvalidAuthenticationError();
  }
  return {
    kind: "service",
    actorId: row.id,
    servicePrincipalId: row.id,
    workspaceId: row.workspace_id,
    displayName: row.name,
    role: row.role,
    scopes,
    ...(row.delegated_user_id ? { delegatedUserId: row.delegated_user_id } : {}),
  };
}

function metadataMatches(
  metadata: Readonly<Record<string, unknown>> | undefined,
  row: ServicePrincipalRow,
): boolean {
  return (
    metadata?.kind === "skillplane_service_principal" &&
    metadata.servicePrincipalId === row.id &&
    metadata.workspaceId === row.workspace_id &&
    metadata.credentialVersion === row.credential_version
  );
}

async function authenticateServiceCredential(
  services: ApiServices,
  token: string,
): Promise<AuthenticatedServicePrincipal> {
  let identity: Awaited<ReturnType<typeof services.auth.apiKeys.authenticate>>;
  try {
    identity = await services.auth.apiKeys.authenticate(token);
  } catch (error) {
    if (error instanceof AuthFnApiKeyRevokedError) {
      throw new InvalidAuthenticationError();
    }
    throw error;
  }
  if (identity?.type !== "api-key" || identity.actorType !== "api-key") {
    throw new InvalidAuthenticationError();
  }
  const result = await services.controlDatabase.pool.query<ServicePrincipalRow>(
    `SELECT id, workspace_id, name, role, scopes, delegated_user_id,
            expires_at, revoked_at, credential_version, authfn_api_key_id
       FROM service_principals
      WHERE authfn_api_key_id = $1
      LIMIT 1`,
    [identity.actorId],
  );
  const row = result.rows[0];
  if (
    !row ||
    row.revoked_at ||
    row.authfn_api_key_id !== identity.actorId ||
    !metadataMatches(identity.metadata, row)
  ) {
    throw new InvalidAuthenticationError();
  }
  const principal = servicePrincipal(row);
  await services.controlDatabase.pool.query(
    `UPDATE service_principals
        SET last_used_at = now()
      WHERE id = $1
        AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`,
    [row.id],
  );
  return {
    principal,
    credentialId: identity.actorId,
    credentialKind: "service_principal",
  };
}

export async function authenticateServicePrincipalRequest(
  request: Request,
  services: ApiServices,
): Promise<AuthenticatedServicePrincipal | null> {
  const authorization = request.headers.get("authorization")?.trim();
  if (!authorization) return null;
  const bearer = /^Bearer[ \t]+/iu.exec(authorization);
  if (!bearer) return null;
  const token = authorization.slice(bearer[0].length).trim();
  if (token.startsWith("spk_")) {
    return authenticateServiceCredential(services, token);
  }
  return null;
}
