import { createHash } from "node:crypto";
import { verifyAccessToken } from "@skillplane/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  oauthForm,
  startOAuthTestEnvironment,
  verifyTestAccessToken,
  type OAuthTestEnvironment,
  type RegisteredTestClient,
} from "../support/oauth-test-environment.test.support.js";

function authorizationUrl(
  client: RegisteredTestClient,
  overrides: Readonly<Record<string, string>> = {},
): URL {
  const verifier = `security-verifier-${"b".repeat(50)}`;
  const url = new URL(`${OAUTH_ISSUER}/auth/oauth/authorize`);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: client.clientId,
    redirect_uri: client.redirectUri,
    resource: OAUTH_RESOURCE,
    scope: "skills:read",
    state: "security-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    ...overrides,
  }).toString();
  return url;
}

describe("OAuth attack and leakage defenses", () => {
  let environment: OAuthTestEnvironment;
  let client: RegisteredTestClient;

  beforeAll(async () => {
    environment = await startOAuthTestEnvironment("security");
    client = await environment.registerClient();
  });

  afterAll(async () => {
    await environment.close();
  });

  it.each([
    {
      name: "remote cleartext redirect",
      redirect: "http://agent.example.test/callback",
    },
    {
      name: "credential-bearing redirect",
      redirect: "https://user:password@agent.example.test/callback",
    },
    {
      name: "fragment redirect",
      redirect: "https://agent.example.test/callback#fragment",
    },
    {
      name: "wildcard redirect",
      redirect: "https://*.example.test/callback",
    },
  ])("rejects $name during dynamic registration", async ({ redirect }, index) => {
    const response = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": `198.51.100.${String(20 + index)}`,
        },
        body: JSON.stringify({
          client_name: "Unsafe Agent",
          redirect_uris: [redirect],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("rejects dynamic registration without a client name", async () => {
    const response = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/register`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "198.51.100.29",
        },
        body: JSON.stringify({
          redirect_uris: ["https://agent.example.test/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_client_metadata",
    });
  });

  it("never redirects authorization errors to an unregistered URI", async () => {
    const response = await environment.app.fetch(
      new Request(
        authorizationUrl(client, {
          redirect_uri: "https://attacker.example.test/callback",
        }),
        { headers: { cookie: environment.cookie } },
      ),
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    await expect(response.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  it.each([
    ["plain PKCE", { code_challenge_method: "plain" }],
    ["wrong resource", { resource: "https://attacker.example.test/mcp" }],
    ["implicit response", { response_type: "token" }],
    ["unknown scope", { scope: "skills:read admin:all" }],
  ])("returns a trusted OAuth error for %s", async (_name, overrides) => {
    const response = await environment.app.fetch(
      new Request(authorizationUrl(client, overrides), {
        headers: { cookie: environment.cookie },
      }),
    );
    expect(response.status).toBe(302);
    const redirect = response.headers.get("location");
    if (!redirect) throw new Error("Trusted OAuth error redirect is missing");
    const location = new URL(redirect);
    expect(location.origin + location.pathname).toBe(client.redirectUri);
    expect(location.searchParams.get("error")).toBeTruthy();
    expect(location.searchParams.has("code")).toBe(false);
  });

  it("keeps a code usable after wrong PKCE, then rejects successful replay", async () => {
    const grant = await environment.authorize(client, "skills:read");
    const wrong = await environment.exchangeCode(grant, {
      code_verifier: `wrong-verifier-${"x".repeat(50)}`,
    });
    expect(wrong.status).toBe(400);
    await expect(wrong.json()).resolves.toMatchObject({ error: "invalid_grant" });

    const valid = await environment.exchangeCode(grant);
    expect(valid.status).toBe(200);
    const replay = await environment.exchangeCode(grant);
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
  });

  it("keeps authorization-code resource strict and rejects duplicate token resources", async () => {
    const missingGrant = await environment.authorize(client, "skills:read");
    const missingBody = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: missingGrant.code,
      redirect_uri: client.redirectUri,
      code_verifier: missingGrant.verifier,
    });
    const missingResource = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: missingBody,
      }),
    );
    expect(missingResource.status).toBe(400);
    await expect(missingResource.json()).resolves.toMatchObject({
      error: "invalid_target",
    });

    const duplicateGrant = await environment.authorize(client, "skills:read");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.clientId,
      code: duplicateGrant.code,
      redirect_uri: client.redirectUri,
      resource: OAUTH_RESOURCE,
      code_verifier: duplicateGrant.verifier,
    });
    body.append("resource", OAUTH_RESOURCE);
    const duplicate = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body,
      }),
    );
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: "invalid_request",
    });
  });

  it("rejects explicit refresh audience mismatches without consuming the grant", async () => {
    const grant = await environment.authorize(client, "skills:read");
    const exchange = await environment.exchangeCode(grant);
    const tokens = (await exchange.json()) as { readonly refresh_token: string };
    const refresh = (resource?: string) =>
      environment.app.fetch(
        new Request(
          `${OAUTH_ISSUER}/auth/oauth/token`,
          oauthForm({
            grant_type: "refresh_token",
            client_id: client.clientId,
            refresh_token: tokens.refresh_token,
            ...(resource !== undefined ? { resource } : {}),
          }),
        ),
      );

    const duplicateBody = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client.clientId,
      refresh_token: tokens.refresh_token,
      resource: OAUTH_RESOURCE,
    });
    duplicateBody.append("resource", OAUTH_RESOURCE);
    const duplicate = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: duplicateBody,
      }),
    );
    expect(duplicate.status).toBe(400);
    await expect(duplicate.json()).resolves.toMatchObject({
      error: "invalid_request",
    });

    const mismatched = await refresh("https://attacker.example.test/mcp");
    expect(mismatched.status).toBe(400);
    await expect(mismatched.json()).resolves.toMatchObject({
      error: "invalid_target",
    });
    expect((await refresh()).status).toBe(200);
  });

  it("requires AuthFn CSRF verification for a consent decision", async () => {
    const start = await environment.app.fetch(
      new Request(authorizationUrl(client), {
        headers: { cookie: environment.cookie },
      }),
    );
    const consentLocation = start.headers.get("location");
    if (!consentLocation) throw new Error("Consent redirect is missing");
    const consent = new URL(consentLocation);
    const requestToken = consent.searchParams.get("request");
    expect(requestToken).toBeTruthy();
    const response = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/consent`, {
        method: "POST",
        headers: {
          cookie: environment.cookie,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request: requestToken, approved: true }),
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: "access_denied",
    });
  });

  it("revokes an entire refresh family when an old token is reused", async () => {
    const grant = await environment.authorize(client, "skills:read");
    const initial = await environment.exchangeCode(grant);
    const first = (await initial.json()) as {
      readonly refresh_token: string;
    };
    const rotate = () =>
      environment.app.fetch(
        new Request(
          `${OAUTH_ISSUER}/auth/oauth/token`,
          oauthForm({
            grant_type: "refresh_token",
            client_id: client.clientId,
            refresh_token: first.refresh_token,
            resource: OAUTH_RESOURCE,
          }),
        ),
      );
    const rotatedResponse = await rotate();
    expect(rotatedResponse.status).toBe(200);
    const rotated = (await rotatedResponse.json()) as {
      readonly access_token: string;
    };
    const replay = await rotate();
    expect(replay.status).toBe(400);
    await expect(replay.json()).resolves.toMatchObject({ error: "invalid_grant" });
    await expect(
      verifyTestAccessToken(environment, rotated.access_token),
    ).rejects.toMatchObject({ status: 401 });

    const audit = await environment.services.database.pool.query<{
      event_type: string;
      outcome: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, outcome, metadata
         FROM audit_events
        WHERE user_id = $1 AND event_type = 'oauth.refresh.reuse_detected'`,
      [environment.fixture.userId],
    );
    expect(audit.rows).toContainEqual(
      expect.objectContaining({
        event_type: "oauth.refresh.reuse_detected",
        outcome: "error",
      }),
    );
    expect(JSON.stringify(audit.rows)).not.toContain(first.refresh_token);
  });

  it("rejects Basic client authentication and mismatched audience", async () => {
    const basic = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/token`, {
        ...oauthForm({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: "spr_unknown",
          resource: OAUTH_RESOURCE,
        }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          authorization: "Basic Y2xpZW50OnNlY3JldA==",
        },
      }),
    );
    expect(basic.status).toBe(401);
    await expect(basic.json()).resolves.toMatchObject({ error: "invalid_client" });

    const grant = await environment.authorize(client, "skills:read");
    const exchanged = await environment.exchangeCode(grant);
    const token = (await exchanged.json()) as { readonly access_token: string };
    await expect(
      verifyTestAccessToken(environment, token.access_token),
    ).resolves.toBeTruthy();
    await expect(
      verifyAccessToken(environment.services.auth.oauth, token.access_token, {
        resource: "https://attacker.example.test/mcp",
        requiredScopes: ["skills:read"],
      }),
    ).rejects.toMatchObject({ status: 401 });
  });

  it("rate-limits unauthenticated dynamic registration", async () => {
    const clientIds: string[] = [];
    const network = "203.0.113.222";
    try {
      for (let index = 0; index < 11; index += 1) {
        const response = await environment.app.fetch(
          new Request(`${OAUTH_ISSUER}/auth/oauth/register`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "cf-connecting-ip": network,
            },
            body: JSON.stringify({
              client_name: `Rate Agent ${String(index)}`,
              redirect_uris: [`https://rate-${String(index)}.example.test/callback`],
              token_endpoint_auth_method: "none",
            }),
          }),
        );
        if (index < 10) {
          expect(response.status).toBe(201);
          const body = (await response.json()) as { readonly client_id: string };
          clientIds.push(body.client_id);
        } else {
          expect(response.status).toBe(429);
          expect(response.headers.get("retry-after")).toMatch(/^\d+$/);
          await expect(response.json()).resolves.toMatchObject({
            error: "temporarily_unavailable",
          });
        }
      }
    } finally {
      if (clientIds.length > 0) {
        await environment.services.database.pool.query(
          "DELETE FROM authfn_oauth_clients WHERE client_id = ANY($1::text[])",
          [clientIds],
        );
      }
    }
  });
});
