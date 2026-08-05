import { Client, type ClientOptions } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { buildApiServices, createApiApp, type ApiServices } from "@skillplane/api";
import {
  AUTH_CSRF_COOKIE,
  AUTH_CSRF_HEADER,
  AUTH_SESSION_COOKIE,
} from "@skillplane/auth";
import type { CallerDeclaration } from "@skillplane/mcp-schema";
import type {
  SkillRecord,
  SkillVersionRecord,
  UserPrincipal,
} from "@skillplane/domain";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  createSkillBundleFixture,
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { createHash } from "node:crypto";
import { createMcpApp } from "../../src/index.js";

export const TEST_OAUTH_ISSUER = "https://app.skillplane.dev";
export const TEST_MCP_RESOURCE = "https://mcp.skillplane.dev/mcp";
export const TEST_OAUTH_PEPPER = "mcp-read-test-token-pepper-at-least-32-characters";

export const TEST_CALLER: CallerDeclaration = {
  agentId: "agent:test-codex",
  agentName: "Codex",
  modelProvider: "OpenAI",
  modelName: "gpt-5.6",
  modelVersion: "2026-07-26",
  clientName: "Skillplane MCP integration fixture",
  clientVersion: "1.0.0",
  runId: "run:mcp-read",
  sessionId: "session:mcp-read",
  conversationId: "conversation:mcp-read",
};

interface OAuthClientFixture {
  readonly clientId: string;
  readonly redirectUri: string;
}

interface OAuthTokenResponse {
  readonly access_token: string;
  readonly token_type: "Bearer";
  readonly expires_in: number;
  readonly scope: string;
}

export interface McpSkillFixture {
  readonly skill: SkillRecord;
  readonly version: SkillVersionRecord;
  readonly candidate: SkillVersionRecord;
  readonly context: Awaited<ReturnType<ApiServices["contextService"]["create"]>>;
  readonly notes: readonly [
    Awaited<ReturnType<ApiServices["contextNoteService"]["create"]>>,
    Awaited<ReturnType<ApiServices["contextNoteService"]["create"]>>,
  ];
  readonly markdown: string;
  readonly checklist: string;
  readonly largeAsset: Uint8Array;
}

export interface ConnectedMcpClient {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
}

export interface McpTestEnvironment {
  readonly databaseUrl: string;
  readonly owner: TenantFixture;
  readonly outsider: TenantFixture;
  readonly services: ApiServices;
  readonly storage: TestObjectStorage;
  readonly skill: McpSkillFixture;
  readonly privateSkill: {
    readonly skill: SkillRecord;
    readonly version: SkillVersionRecord;
  };
  readonly app: ReturnType<typeof createMcpApp>;
  readonly serviceToken: string;
  readonly skillsOnlyToken: string;
  readonly outsiderServiceToken: string;
  readonly revokedServiceToken: string;
  issueOAuthToken(scopes?: string): Promise<string>;
  connect(token: string, options?: ClientOptions): Promise<ConnectedMcpClient>;
  rawMcp(token: string | null, body: unknown): Promise<Response>;
  close(): Promise<void>;
}

function ownerPrincipal(fixture: TenantFixture): UserPrincipal {
  return {
    kind: "user",
    actorId: fixture.userId,
    userId: fixture.userId,
    sessionId: `fixture:${fixture.sessionToken.slice(0, 12)}`,
    workspaceId: fixture.workspaceId,
    role: "owner",
  };
}

function form(values: Readonly<Record<string, string>>): string {
  return new URLSearchParams(values).toString();
}

async function insertServiceCredential(
  services: ApiServices,
  input: {
    readonly suffix: string;
    readonly workspaceId: string;
    readonly userId: string;
    readonly role: "viewer" | "editor" | "admin";
    readonly scopes: readonly string[];
    readonly revoked?: boolean;
    readonly delegated?: boolean;
  },
): Promise<string> {
  const servicePrincipalId = `service-principal:${input.suffix}`;
  const created = await services.auth.apiKeys.create({
    ownerUserId: input.userId,
    name: `MCP ${input.suffix}`,
    scopes: input.scopes,
    metadata: {
      kind: "skillplane_service_principal",
      servicePrincipalId,
      workspaceId: input.workspaceId,
      credentialVersion: 1,
    },
    expiresAt: null,
    requestId: `fixture:service-principal:${input.suffix}:created`,
  });
  await services.database.pool.query(
    `INSERT INTO service_principals
       (id, workspace_id, name, role, scopes, authfn_api_key_id,
        created_by_user_id, delegated_user_id, revoked_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      servicePrincipalId,
      input.workspaceId,
      `MCP ${input.suffix}`,
      input.role,
      input.scopes,
      created.keyId,
      input.userId,
      input.delegated ? input.userId : null,
      input.revoked ? new Date() : null,
    ],
  );
  if (input.revoked) {
    await services.auth.apiKeys.revoke({
      keyId: created.keyId,
      actorId: input.userId,
      requestId: `fixture:service-principal:${input.suffix}:revoked`,
    });
  }
  return created.secret;
}

async function seedSkill(
  services: ApiServices,
  owner: TenantFixture,
  suffix: string,
): Promise<McpSkillFixture> {
  const principal = ownerPrincipal(owner);
  const slug = `review-plane-${suffix}`;
  const markdown =
    "# Review plane\n\nInspect authorization boundaries before style. Return evidence with every finding.\n";
  const checklist =
    "# Checklist\n\n- Confirm tenant scope\n- Verify exact bundle digest\n- Record audit before disclosure\n";
  const largeAsset = new Uint8Array(300 * 1024);
  crypto.getRandomValues(largeAsset.subarray(0, 65_536));
  for (let offset = 65_536; offset < largeAsset.length; offset += 65_536) {
    largeAsset.set(
      largeAsset.subarray(0, Math.min(65_536, largeAsset.length - offset)),
      offset,
    );
  }
  const archive = await createSkillBundleFixture({
    name: "Review plane",
    slug,
    description: "Authorization-first pull request review guidance",
    tags: ["review", "authorization"],
    skillMarkdown: markdown,
    files: {
      "references/checklist.md": checklist,
      "assets/large.bin": largeAsset,
      "assets/icon.bin": new Uint8Array([0, 1, 2, 3, 254, 255]),
    },
  });
  const created = await services.skillService.create({
    workspaceId: owner.workspaceId,
    principal,
    archiveBytes: archive,
    visibility: "public",
    idempotencyKey: `create-skill-${suffix}`,
    requestId: `fixture:create-skill:${suffix}`,
  });
  const candidateArchive = await createSkillBundleFixture({
    name: "Review plane",
    slug,
    description: "Authorization-first pull request review guidance",
    tags: ["review", "authorization"],
    skillMarkdown: `${markdown}\nValidate scope challenges before fetching assets.\n`,
    files: {
      "references/checklist.md": `${checklist}\n- Validate scopes\n`,
      "assets/large.bin": largeAsset,
      "assets/icon.bin": new Uint8Array([0, 1, 2, 3, 254, 255]),
    },
  });
  const candidate = await services.skillVersionService.createCandidate({
    skillId: created.skill.id,
    principal,
    baseVersionId: created.version.id,
    proposedBump: "patch",
    changeSummary: "Add explicit scope validation guidance",
    archiveBytes: candidateArchive,
    idempotencyKey: `candidate-${suffix}`,
    requestId: `fixture:candidate:${suffix}`,
  });
  const context = await services.contextService.create({
    skillId: created.skill.id,
    principal,
    slug: `repository-${suffix}`,
    name: "Skillplane repository",
    type: "repository",
    externalReference: "https://example.test/skillplane",
    description: "Repository-specific pull request review knowledge",
    metadata: { branch: "main", language: "TypeScript" },
    initialKnowledge:
      "# Repository knowledge\n\nUse pnpm gates and verify tenant predicates inside SQL.\n",
    learningMetadata: {
      summary: "Learned from repository review",
      evidence: ["review:fixture"],
    },
    idempotencyKey: `context-${suffix}`,
    requestId: `fixture:context:${suffix}`,
  });
  const firstNote = await services.contextNoteService.create({
    contextId: context.context.id,
    principal,
    title: "Authorization invariant",
    body: "Resolve workspace membership before any private R2 read.",
    learningMetadata: { source: "integration-fixture" },
    idempotencyKey: `note-first-${suffix}`,
    requestId: `fixture:note:first:${suffix}`,
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const secondNote = await services.contextNoteService.create({
    contextId: context.context.id,
    principal,
    title: "Digest invariant",
    body: "Recompute and compare canonical bundle digests before disclosure.",
    learningMetadata: { source: "integration-fixture" },
    idempotencyKey: `note-second-${suffix}`,
    requestId: `fixture:note:second:${suffix}`,
  });
  return {
    skill: created.skill,
    version: created.version,
    candidate,
    context,
    notes: [firstNote, secondNote],
    markdown,
    checklist,
    largeAsset,
  };
}

async function seedPrivateSkill(
  services: ApiServices,
  owner: TenantFixture,
  suffix: string,
) {
  const archive = await createSkillBundleFixture({
    name: "Private incident review",
    slug: `private-review-${suffix}`,
    description: "Private incident response review knowledge",
    tags: ["private", "incident"],
    skillMarkdown:
      "# Private incident review\n\nNever disclose this fixture publicly.\n",
  });
  return services.skillService.create({
    workspaceId: owner.workspaceId,
    principal: ownerPrincipal(owner),
    archiveBytes: archive,
    visibility: "private",
    idempotencyKey: `private-skill-${suffix}`,
    requestId: `fixture:private-skill:${suffix}`,
  });
}

export function parseStructured<T>(result: CallToolResult): T {
  if (result.structuredContent) return result.structuredContent as T;
  const text = result.content.find((item) => item.type === "text");
  if (!text || text.type !== "text") {
    throw new Error("MCP result did not contain structured or JSON text content");
  }
  return JSON.parse(text.text) as T;
}

export function parseToolError(result: CallToolResult): {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: boolean;
    readonly requestId: string;
  };
} {
  if (result.isError !== true) throw new Error("Expected an MCP tool error");
  return parseStructured(result);
}

export async function startMcpTestEnvironment(
  label: string,
): Promise<McpTestEnvironment> {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  const short = crypto.randomUUID().replaceAll("-", "").slice(0, 10);
  const suffix = `mcp-${label}-${short}`;
  const outsiderSuffix = `${suffix}-outsider`;
  const owner = await seedTenantFixture(databaseUrl, suffix);
  const outsider = await seedTenantFixture(databaseUrl, outsiderSuffix);
  const storage = new TestObjectStorage();
  const services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: storage,
    OAUTH_ISSUER: TEST_OAUTH_ISSUER,
    OAUTH_TOKEN_PEPPER: TEST_OAUTH_PEPPER,
  });
  const skill = await seedSkill(services, owner, short);
  const privateSkill = await seedPrivateSkill(services, owner, short);
  const serviceToken = await insertServiceCredential(services, {
    suffix: `${suffix}:reader`,
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    role: "editor",
    scopes: ["skills:read", "skills:amend", "contexts:read", "contexts:write"],
  });
  const skillsOnlyToken = await insertServiceCredential(services, {
    suffix: `${suffix}:skills-only`,
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    role: "viewer",
    scopes: ["skills:read"],
  });
  const outsiderServiceToken = await insertServiceCredential(services, {
    suffix: `${suffix}:outsider`,
    workspaceId: outsider.workspaceId,
    userId: outsider.userId,
    role: "editor",
    scopes: ["skills:read", "skills:amend", "contexts:read", "contexts:write"],
  });
  const revokedServiceToken = await insertServiceCredential(services, {
    suffix: `${suffix}:revoked`,
    workspaceId: owner.workspaceId,
    userId: owner.userId,
    role: "editor",
    scopes: ["skills:read", "contexts:read"],
    revoked: true,
  });
  const apiApp = createApiApp({
    getServices: async () => services,
    requestId: () => `req:mcp-oauth:${crypto.randomUUID()}`,
  });
  const mcpApp = createMcpApp({
    getServices: async () => services,
  });
  const cookie = `${AUTH_SESSION_COOKIE}=${encodeURIComponent(
    owner.sessionToken,
  )}; ${AUTH_CSRF_COOKIE}=${encodeURIComponent(owner.csrfToken)}`;
  const oauthClientIds = new Set<string>();
  const connectedClients = new Set<Client>();

  async function registerOAuthClient(scope: string): Promise<OAuthClientFixture> {
    const redirectUri = "https://agent.example.test/oauth/callback";
    const response = await apiApp.fetch(
      new Request(`${TEST_OAUTH_ISSUER}/auth/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.24",
        },
        body: JSON.stringify({
          client_name: "Skillplane MCP read fixture",
          redirect_uris: [redirectUri],
          token_endpoint_auth_method: "none",
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          scope,
        }),
      }),
    );
    if (response.status !== 201) {
      throw new Error(`OAuth registration failed: ${await response.text()}`);
    }
    const body = (await response.json()) as { readonly client_id: string };
    oauthClientIds.add(body.client_id);
    return { clientId: body.client_id, redirectUri };
  }

  async function issueOAuthToken(
    scopes = "skills:read contexts:read",
  ): Promise<string> {
    const client = await registerOAuthClient(scopes);
    const verifier = `mcp-verifier-${"a".repeat(52)}`;
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorizeUrl = new URL(`${TEST_OAUTH_ISSUER}/auth/oauth/authorize`);
    authorizeUrl.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      resource: TEST_MCP_RESOURCE,
      scope: scopes,
      state: "mcp-read-state",
      code_challenge: challenge,
      code_challenge_method: "S256",
    }).toString();
    const begin = await apiApp.fetch(
      new Request(authorizeUrl, {
        headers: {
          cookie,
          "cf-connecting-ip": "198.51.100.24",
        },
      }),
    );
    if (begin.status !== 302) {
      throw new Error(`OAuth authorize failed: ${await begin.text()}`);
    }
    const location = begin.headers.get("location");
    const requestToken = location
      ? new URL(location).searchParams.get("request")
      : null;
    if (!requestToken) throw new Error("OAuth consent request is missing");
    const details = await apiApp.fetch(
      new Request(
        `${TEST_OAUTH_ISSUER}/auth/oauth/consent?request=${encodeURIComponent(
          requestToken,
        )}`,
        { headers: { cookie } },
      ),
    );
    if (details.status !== 200) {
      throw new Error(`OAuth consent lookup failed: ${await details.text()}`);
    }
    const consent = await apiApp.fetch(
      new Request(`${TEST_OAUTH_ISSUER}/auth/oauth/consent`, {
        method: "POST",
        headers: {
          cookie,
          [AUTH_CSRF_HEADER]: owner.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request: requestToken, approved: true }),
      }),
    );
    if (consent.status !== 200) {
      throw new Error(`OAuth consent failed: ${await consent.text()}`);
    }
    const consentBody = (await consent.json()) as {
      readonly redirectTo: string;
    };
    const code = new URL(consentBody.redirectTo).searchParams.get("code");
    if (!code) throw new Error("OAuth code is missing");
    const token = await apiApp.fetch(
      new Request(`${TEST_OAUTH_ISSUER}/auth/oauth/token`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "198.51.100.24",
        },
        body: form({
          grant_type: "authorization_code",
          client_id: client.clientId,
          code,
          redirect_uri: client.redirectUri,
          resource: TEST_MCP_RESOURCE,
          code_verifier: verifier,
        }),
      }),
    );
    if (token.status !== 200) {
      throw new Error(`OAuth token exchange failed: ${await token.text()}`);
    }
    return ((await token.json()) as OAuthTokenResponse).access_token;
  }

  async function connect(
    token: string,
    options: ClientOptions = {},
  ): Promise<ConnectedMcpClient> {
    const transport = new StreamableHTTPClientTransport(new URL(TEST_MCP_RESOURCE), {
      requestInit: {
        headers: { authorization: `Bearer ${token}` },
      },
      fetch: async (input, init) => {
        const request =
          input instanceof Request
            ? new Request(input, init)
            : new Request(input, init);
        return mcpApp.fetch(request);
      },
    });
    const client = new Client(
      { name: "skillplane-test-client", version: "1.0.0" },
      options,
    );
    await client.connect(transport);
    connectedClients.add(client);
    return { client, transport };
  }

  async function rawMcp(token: string | null, body: unknown): Promise<Response> {
    return mcpApp.fetch(
      new Request(TEST_MCP_RESOURCE, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  return {
    databaseUrl,
    owner,
    outsider,
    services,
    storage,
    skill,
    privateSkill,
    app: mcpApp,
    serviceToken,
    skillsOnlyToken,
    outsiderServiceToken,
    revokedServiceToken,
    issueOAuthToken,
    connect,
    rawMcp,
    async close() {
      await Promise.allSettled([...connectedClients].map((client) => client.close()));
      if (oauthClientIds.size > 0) {
        await services.database.pool.query(
          `DELETE FROM authfn_oauth_authorization_requests
            WHERE payload->>'clientId' = ANY($1::text[])`,
          [[...oauthClientIds]],
        );
        await services.database.pool.query(
          "DELETE FROM authfn_oauth_clients WHERE client_id = ANY($1::text[])",
          [[...oauthClientIds]],
        );
      }
      await services.datafn.close();
      await services.email?.close();
      await services.database.close();
      await purgeTenantFixture(databaseUrl, suffix);
      await purgeTenantFixture(databaseUrl, outsiderSuffix);
    },
  };
}
