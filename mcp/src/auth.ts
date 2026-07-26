import {
  protectedResourceChallenge,
  readBearerToken,
  verifyAccessToken,
} from "@skillplane/auth";
import type { ApiServices } from "@skillplane/api";
import {
  SERVICE_PRINCIPAL_SCOPES,
  assertServicePrincipalActive,
  authorize,
  isWorkspaceRole,
  type Principal,
  type ServicePrincipal,
  type ServicePrincipalScope,
  type UserPrincipal,
  type WorkspaceAction,
} from "@skillplane/domain";

export type McpScope =
  "skills:read" | "skills:amend" | "contexts:read" | "contexts:write";

export interface OAuthMcpIdentity {
  readonly kind: "oauth";
  readonly actorType: "user";
  readonly actorId: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly credentialKind: "oauth_access_token";
  readonly clientId: string;
  readonly scopes: readonly string[];
}

export interface ServiceMcpIdentity {
  readonly kind: "service";
  readonly actorType: "service_principal";
  readonly actorId: string;
  readonly userId: string | null;
  readonly credentialId: string;
  readonly credentialKind: "service_principal";
  readonly workspaceId: string;
  readonly displayName: string;
  readonly role: ServicePrincipal["role"];
  readonly scopes: readonly ServicePrincipalScope[];
}

export type McpIdentity = OAuthMcpIdentity | ServiceMcpIdentity;

interface ServicePrincipalRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly name: string;
  readonly role: string;
  readonly scopes: string[];
  readonly delegated_user_id: string | null;
  readonly expires_at: Date | null;
  readonly revoked_at: Date | null;
}

interface MembershipRow {
  readonly role: string;
}

export class McpAuthenticationError extends Error {
  readonly status: 401 | 403;
  readonly scopes: readonly McpScope[];

  constructor(status: 401 | 403, message: string, scopes: readonly McpScope[] = []) {
    super(message);
    this.name = "McpAuthenticationError";
    this.status = status;
    this.scopes = scopes;
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function normalizeRequiredScopes(values: readonly string[]): readonly McpScope[] {
  return [
    ...new Set(
      values.filter(
        (value): value is McpScope =>
          value === "skills:read" ||
          value === "skills:amend" ||
          value === "contexts:read" ||
          value === "contexts:write",
      ),
    ),
  ].sort();
}

function scopesForToolCall(message: unknown): readonly McpScope[] {
  if (!message || typeof message !== "object" || Array.isArray(message)) return [];
  const record = message as {
    readonly method?: unknown;
    readonly params?: {
      readonly name?: unknown;
      readonly arguments?: unknown;
    };
  };
  if (record.method !== "tools/call" || typeof record.params?.name !== "string") {
    return [];
  }
  switch (record.params.name) {
    case "skills_search":
    case "skill_asset_retrieve":
    case "skill_versions_list":
      return ["skills:read"];
    case "skill_retrieve": {
      const args = record.params.arguments;
      const hasContext =
        args !== null &&
        args !== undefined &&
        typeof args === "object" &&
        !Array.isArray(args) &&
        "context" in args;
      return hasContext ? ["contexts:read", "skills:read"] : ["skills:read"];
    }
    case "context_get":
    case "context_notes_list":
      return ["contexts:read"];
    case "skill_amend":
      return ["skills:amend"];
    case "context_knowledge_update":
    case "context_note_upsert":
      return ["contexts:write"];
    default:
      return [];
  }
}

export async function requiredScopesForRequest(
  request: Request,
): Promise<readonly McpScope[]> {
  if (request.method !== "POST") return [];
  try {
    const body: unknown = await request.clone().json();
    const messages = Array.isArray(body) ? body : [body];
    return normalizeRequiredScopes(messages.flatMap(scopesForToolCall));
  } catch {
    return [];
  }
}

async function authenticateService(
  services: ApiServices,
  token: string,
): Promise<ServiceMcpIdentity> {
  const result = await services.database.pool.query<ServicePrincipalRow>(
    `SELECT id, workspace_id, name, role, scopes, delegated_user_id,
            expires_at, revoked_at
       FROM service_principals
      WHERE credential_hash = $1
      LIMIT 1`,
    [await sha256(token)],
  );
  const row = result.rows[0];
  const scopes = row?.scopes.filter((scope): scope is ServicePrincipalScope =>
    (SERVICE_PRINCIPAL_SCOPES as readonly string[]).includes(scope),
  );
  if (
    !row ||
    !isWorkspaceRole(row.role) ||
    row.role === "owner" ||
    scopes?.length !== row.scopes.length
  ) {
    throw new McpAuthenticationError(401, "The bearer credential is invalid");
  }
  try {
    assertServicePrincipalActive({
      revokedAt: row.revoked_at,
      expiresAt: row.expires_at,
      scopes,
    });
  } catch {
    throw new McpAuthenticationError(401, "The bearer credential is invalid");
  }
  await services.database.pool.query(
    "UPDATE service_principals SET last_used_at = now() WHERE id = $1",
    [row.id],
  );
  return {
    kind: "service",
    actorType: "service_principal",
    actorId: row.id,
    userId: row.delegated_user_id,
    credentialId: row.id,
    credentialKind: "service_principal",
    workspaceId: row.workspace_id,
    displayName: row.name,
    role: row.role,
    scopes,
  };
}

export function assertMcpScopes(
  identity: McpIdentity,
  requiredScopes: readonly McpScope[],
): void {
  const missing = requiredScopes.filter((scope) => !identity.scopes.includes(scope));
  if (missing.length > 0) {
    throw new McpAuthenticationError(
      403,
      "The bearer credential lacks a required scope",
      missing,
    );
  }
}

export async function authenticateMcpRequest(
  request: Request,
  services: ApiServices,
  additionalScopes: readonly McpScope[] = [],
): Promise<McpIdentity> {
  let token: string;
  try {
    token = readBearerToken(request);
  } catch {
    throw new McpAuthenticationError(401, "A valid bearer credential is required");
  }
  const requiredScopes = normalizeRequiredScopes([
    ...(await requiredScopesForRequest(request)),
    ...additionalScopes,
  ]);
  let identity: McpIdentity;
  if (token.startsWith("sps_")) {
    identity = await authenticateService(services, token);
  } else {
    try {
      const verified = await verifyAccessToken(services.auth.oauth, token, {
        resource: services.auth.oauth.resource,
      });
      identity = {
        kind: "oauth",
        actorType: "user",
        actorId: verified.userId,
        userId: verified.userId,
        credentialId: verified.tokenId,
        credentialKind: "oauth_access_token",
        clientId: verified.clientId,
        scopes: verified.scopes,
      };
    } catch {
      throw new McpAuthenticationError(401, "The bearer credential is invalid");
    }
  }
  assertMcpScopes(identity, requiredScopes);
  return identity;
}

export function mcpAuthenticationResponse(
  services: ApiServices | null,
  error: McpAuthenticationError,
): Response {
  const runtime = services?.auth.oauth ?? {
    resource: "https://mcp.skillplane.dev/mcp",
  };
  const challenge = protectedResourceChallenge(runtime, {
    error: error.status === 403 ? "insufficient_scope" : "invalid_token",
    ...(error.scopes.length > 0 ? { scopes: error.scopes } : {}),
  });
  return new Response(
    JSON.stringify({
      error: error.status === 403 ? "insufficient_scope" : "invalid_token",
      error_description: error.message,
    }),
    {
      status: error.status,
      headers: {
        "cache-control": "no-store",
        "content-type": "application/json",
        pragma: "no-cache",
        "www-authenticate": challenge,
        "x-content-type-options": "nosniff",
      },
    },
  );
}

export async function principalForWorkspace(
  services: ApiServices,
  identity: McpIdentity,
  workspaceId: string,
  action: WorkspaceAction,
  options: { readonly allowPublicWithoutMembership?: boolean } = {},
): Promise<Principal | null> {
  if (identity.kind === "service") {
    if (identity.workspaceId !== workspaceId) {
      if (options.allowPublicWithoutMembership) return null;
      throw new Error("WORKSPACE_FORBIDDEN");
    }
    const principal: ServicePrincipal = {
      kind: "service",
      actorId: identity.actorId,
      servicePrincipalId: identity.credentialId,
      workspaceId: identity.workspaceId,
      displayName: identity.displayName,
      role: identity.role,
      scopes: identity.scopes,
      ...(identity.userId ? { delegatedUserId: identity.userId } : {}),
    };
    authorize(principal, action);
    return principal;
  }
  const membership = await services.database.pool.query<MembershipRow>(
    `SELECT role
       FROM workspace_memberships
      WHERE workspace_id = $1 AND user_id = $2
      LIMIT 1`,
    [workspaceId, identity.userId],
  );
  const row = membership.rows[0];
  if (!row || !isWorkspaceRole(row.role)) {
    if (options.allowPublicWithoutMembership) return null;
    throw new Error("WORKSPACE_FORBIDDEN");
  }
  const principal: UserPrincipal = {
    kind: "user",
    actorId: identity.userId,
    userId: identity.userId,
    sessionId: `oauth-token:${identity.credentialId}`,
    workspaceId,
    role: row.role,
  };
  authorize(principal, action);
  return principal;
}
