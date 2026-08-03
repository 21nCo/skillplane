import {
  AUTH_CSRF_COOKIE,
  AUTH_CSRF_HEADER,
  AUTH_SESSION_COOKIE,
  verifyAccessToken,
} from "@skillplane/auth";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { createHash } from "node:crypto";
import { createApiApp } from "../../src/app.js";
import { buildApiServices } from "../../src/services.js";

export const OAUTH_ISSUER = "https://app.skillplane.dev";
export const OAUTH_RESOURCE = "https://mcp.skillplane.dev/mcp";
export const OAUTH_PEPPER = "api-oauth-test-token-pepper-32-characters";

function formBody(values: Readonly<Record<string, string>>): string {
  return new URLSearchParams(values).toString();
}

export interface RegisteredTestClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUri: string;
  readonly registrationAccessToken: string;
  readonly registrationClientUri: string;
}

export interface OAuthGrant {
  readonly client: RegisteredTestClient;
  readonly code: string;
  readonly verifier: string;
}

export interface OAuthTestEnvironment {
  readonly app: ReturnType<typeof createApiApp>;
  readonly databaseUrl: string;
  readonly fixture: TenantFixture;
  readonly network: string;
  readonly services: Awaited<ReturnType<typeof buildApiServices>>;
  readonly cookie: string;
  registerClient(input?: {
    readonly name?: string;
    readonly redirectUri?: string;
  }): Promise<RegisteredTestClient>;
  authorize(client: RegisteredTestClient, scopes?: string): Promise<OAuthGrant>;
  exchangeCode(
    grant: OAuthGrant,
    overrides?: Partial<Record<string, string>>,
  ): Promise<Response>;
  close(): Promise<void>;
}

export async function startOAuthTestEnvironment(
  label: string,
): Promise<OAuthTestEnvironment> {
  const databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  const suffix = `oauth-${label}-${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}`;
  const fixture = await seedTenantFixture(databaseUrl, suffix);
  const network = `198.51.100.${String((Date.now() % 200) + 1)}`;
  const services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "disabled",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
    OAUTH_ISSUER,
    OAUTH_TOKEN_PEPPER: OAUTH_PEPPER,
  });
  const app = createApiApp({
    getServices: async () => services,
    requestId: () => `req_oauth_${crypto.randomUUID()}`,
  });
  const cookie = `${AUTH_SESSION_COOKIE}=${encodeURIComponent(
    fixture.sessionToken,
  )}; ${AUTH_CSRF_COOKIE}=${encodeURIComponent(fixture.csrfToken)}`;
  const clientIds = new Set<string>();

  const environment: OAuthTestEnvironment = {
    app,
    databaseUrl,
    fixture,
    network,
    services,
    cookie,
    async registerClient(input = {}) {
      const redirectUri =
        input.redirectUri ?? "https://agent.example.test/oauth/callback";
      const response = await app.fetch(
        new Request(`${OAUTH_ISSUER}/auth/oauth/register`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "cf-connecting-ip": network,
          },
          body: JSON.stringify({
            client_name: input.name ?? "Skillplane Test Agent",
            redirect_uris: [redirectUri],
            token_endpoint_auth_method: "none",
            grant_types: ["authorization_code", "refresh_token"],
            response_types: ["code"],
            scope: "skills:read contexts:read",
          }),
        }),
      );
      if (response.status !== 201) {
        throw new Error(
          `OAuth test client registration failed: ${await response.text()}`,
        );
      }
      const body = (await response.json()) as {
        readonly client_id: string;
        readonly client_name: string;
        readonly registration_access_token: string;
        readonly registration_client_uri: string;
      };
      clientIds.add(body.client_id);
      return {
        clientId: body.client_id,
        clientName: body.client_name,
        redirectUri,
        registrationAccessToken: body.registration_access_token,
        registrationClientUri: body.registration_client_uri,
      };
    },
    async authorize(client, scopes = "skills:read contexts:read") {
      const verifier = `oauth-verifier-${"a".repeat(50)}`;
      const challenge = createHash("sha256").update(verifier).digest("base64url");
      const authorization = new URL(`${OAUTH_ISSUER}/auth/oauth/authorize`);
      authorization.search = new URLSearchParams({
        response_type: "code",
        client_id: client.clientId,
        redirect_uri: client.redirectUri,
        resource: OAUTH_RESOURCE,
        scope: scopes,
        state: "state-fixture",
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      const start = await app.fetch(
        new Request(authorization, {
          headers: { cookie, "cf-connecting-ip": network },
        }),
      );
      if (start.status !== 302) {
        throw new Error(`OAuth authorize failed: ${await start.text()}`);
      }
      const consentLocation = start.headers.get("location");
      if (!consentLocation) throw new Error("OAuth consent redirect is missing");
      const consentUrl = new URL(consentLocation);
      const requestToken = consentUrl.searchParams.get("request");
      if (!requestToken) throw new Error("OAuth consent request token is missing");
      const details = await app.fetch(
        new Request(
          `${OAUTH_ISSUER}/auth/oauth/consent?request=${encodeURIComponent(requestToken)}`,
          { headers: { cookie } },
        ),
      );
      if (details.status !== 200) {
        throw new Error(`OAuth consent details failed: ${await details.text()}`);
      }
      const decision = await app.fetch(
        new Request(`${OAUTH_ISSUER}/auth/oauth/consent`, {
          method: "POST",
          headers: {
            cookie,
            [AUTH_CSRF_HEADER]: fixture.csrfToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({ request: requestToken, approved: true }),
        }),
      );
      if (decision.status !== 200) {
        throw new Error(`OAuth consent failed: ${await decision.text()}`);
      }
      const decisionBody = (await decision.json()) as { readonly redirectTo: string };
      const redirect = new URL(decisionBody.redirectTo);
      const code = redirect.searchParams.get("code");
      if (!code) throw new Error("OAuth authorization code is missing");
      return { client, code, verifier };
    },
    exchangeCode(grant, overrides = {}) {
      return app.fetch(
        new Request(`${OAUTH_ISSUER}/auth/oauth/token`, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "cf-connecting-ip": network,
          },
          body: formBody({
            grant_type: "authorization_code",
            client_id: grant.client.clientId,
            code: grant.code,
            redirect_uri: grant.client.redirectUri,
            resource: OAUTH_RESOURCE,
            code_verifier: grant.verifier,
            ...overrides,
          }),
        }),
      );
    },
    async close() {
      if (clientIds.size > 0) {
        await services.database.pool.query(
          `DELETE FROM authfn_oauth_authorization_requests
            WHERE payload->>'clientId' = ANY($1::text[])`,
          [[...clientIds]],
        );
        await services.database.pool.query(
          "DELETE FROM authfn_oauth_clients WHERE client_id = ANY($1::text[])",
          [[...clientIds]],
        );
      }
      await services.datafn.close();
      await services.email?.close();
      await services.database.close();
      await purgeTenantFixture(databaseUrl, suffix);
    },
  };
  return environment;
}

export async function verifyTestAccessToken(
  environment: OAuthTestEnvironment,
  token: string,
  requiredScopes: readonly string[] = ["skills:read"],
) {
  return verifyAccessToken(environment.services.auth.oauth, token, {
    resource: OAUTH_RESOURCE,
    requiredScopes,
  });
}

export function oauthForm(values: Readonly<Record<string, string>>): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: formBody(values),
  };
}
