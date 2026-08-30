import { AUTH_CSRF_HEADER } from "@skillplane/auth";
import { createHash } from "node:crypto";
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

describe("OAuth 2.1 authorization server integration", () => {
  let environment: OAuthTestEnvironment;
  let client: RegisteredTestClient;

  beforeAll(async () => {
    environment = await startOAuthTestEnvironment("integration");
    client = await environment.registerClient();
  });

  afterAll(async () => {
    await environment.close();
  });

  it("serves authorization-server and both protected-resource metadata paths", async () => {
    const authorization = await environment.app.request(
      "/.well-known/oauth-authorization-server",
    );
    expect(authorization.status).toBe(200);
    expect(authorization.headers.get("cache-control")).toContain("no-store");
    await expect(authorization.json()).resolves.toMatchObject({
      issuer: OAUTH_ISSUER,
      token_endpoint: `${OAUTH_ISSUER}/auth/oauth/token`,
      code_challenge_methods_supported: ["S256"],
      client_id_metadata_document_supported: true,
    });

    for (const path of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
    ]) {
      const resource = await environment.app.request(path);
      expect(resource.status).toBe(200);
      await expect(resource.json()).resolves.toMatchObject({
        resource: OAUTH_RESOURCE,
        authorization_servers: [OAUTH_ISSUER],
        bearer_methods_supported: ["header"],
      });
    }
    expect(
      (await environment.app.request("/.well-known/openid-configuration")).status,
    ).toBe(404);
  });

  it("does not expose legacy dynamic-registration management routes", async () => {
    const registrationPath = `${OAUTH_ISSUER}/auth/oauth/register/${encodeURIComponent(client.clientId)}`;
    for (const request of [
      new Request(registrationPath),
      new Request(registrationPath, { method: "DELETE" }),
    ]) {
      const response = await environment.app.fetch(request);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "ROUTE_NOT_FOUND" },
      });
    }
  });

  it("preserves an unauthenticated request through a safe internal sign-in return", async () => {
    const verifier = `sign-in-verifier-${"d".repeat(50)}`;
    const authorization = new URL(`${OAUTH_ISSUER}/auth/oauth/authorize`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      resource: OAUTH_RESOURCE,
      scope: "skills:read",
      state: "sign-in-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const response = await environment.app.fetch(new Request(authorization));
    expect(response.status).toBe(302);
    const signInLocation = response.headers.get("location");
    if (!signInLocation) throw new Error("Sign-in redirect is missing");
    const signIn = new URL(signInLocation);
    expect(signIn.origin + signIn.pathname).toBe(`${OAUTH_ISSUER}/sign-in`);
    const next = signIn.searchParams.get("next");
    expect(next).toMatch(/^\/oauth\/consent\?request=/);
    expect(next).not.toContain(client.redirectUri);
  });

  it("denies consent with exact state and without issuing a code", async () => {
    const verifier = `denial-verifier-${"e".repeat(50)}`;
    const authorization = new URL(`${OAUTH_ISSUER}/auth/oauth/authorize`);
    authorization.search = new URLSearchParams({
      response_type: "code",
      client_id: client.clientId,
      redirect_uri: client.redirectUri,
      resource: OAUTH_RESOURCE,
      scope: "skills:read",
      state: "deny-state",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    const start = await environment.app.fetch(
      new Request(authorization, { headers: { cookie: environment.cookie } }),
    );
    const consentLocation = start.headers.get("location");
    if (!consentLocation) throw new Error("Consent redirect is missing");
    const consent = new URL(consentLocation);
    const requestToken = consent.searchParams.get("request");
    if (!requestToken) throw new Error("Consent request token is missing");
    const response = await environment.app.fetch(
      new Request(`${OAUTH_ISSUER}/auth/oauth/consent`, {
        method: "POST",
        headers: {
          cookie: environment.cookie,
          [AUTH_CSRF_HEADER]: environment.fixture.csrfToken,
          "content-type": "application/json",
        },
        body: JSON.stringify({ request: requestToken, approved: false }),
      }),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { readonly redirectTo: string };
    const denied = new URL(body.redirectTo);
    expect(denied.searchParams.get("error")).toBe("access_denied");
    expect(denied.searchParams.get("state")).toBe("deny-state");
    expect(denied.searchParams.has("code")).toBe(false);
  });

  it("completes code, S256, refresh rotation, verification, and revocation", async () => {
    const grant = await environment.authorize(client);
    const exchange = await environment.exchangeCode(grant);
    expect(exchange.status).toBe(200);
    expect(exchange.headers.get("cache-control")).toContain("no-store");
    const tokens = (await exchange.json()) as {
      readonly access_token: string;
      readonly refresh_token: string;
      readonly expires_in: number;
      readonly token_type: string;
      readonly scope: string;
    };
    expect(tokens.access_token).toMatch(/^spo_/);
    expect(tokens.refresh_token).toMatch(/^spr_/);
    expect(tokens.expires_in).toBe(3_600);
    expect(tokens.token_type).toBe("Bearer");

    await expect(
      verifyTestAccessToken(environment, tokens.access_token),
    ).resolves.toMatchObject({
      actorType: "user",
      actorId: environment.fixture.userId,
      userId: environment.fixture.userId,
      clientId: client.clientId,
      resource: OAUTH_RESOURCE,
    });

    const refresh = await environment.app.fetch(
      new Request(
        `${OAUTH_ISSUER}/auth/oauth/token`,
        oauthForm({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: tokens.refresh_token,
          resource: OAUTH_RESOURCE,
          scope: "skills:read",
        }),
      ),
    );
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as {
      readonly access_token: string;
      readonly refresh_token: string;
      readonly scope: string;
    };
    expect(rotated.access_token).not.toBe(tokens.access_token);
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.scope).toBe("skills:read");

    const revoke = await environment.app.fetch(
      new Request(
        `${OAUTH_ISSUER}/auth/oauth/revoke`,
        oauthForm({
          client_id: client.clientId,
          token: rotated.refresh_token,
          token_type_hint: "refresh_token",
        }),
      ),
    );
    expect(revoke.status).toBe(200);
    await expect(
      verifyTestAccessToken(environment, rotated.access_token),
    ).rejects.toMatchObject({ code: "invalid_grant", status: 401 });
  });

  it("rotates a Codex refresh request without resource while preserving its stored audience", async () => {
    const grant = await environment.authorize(client, "skills:read contexts:read");
    const exchange = await environment.exchangeCode(grant);
    expect(exchange.status).toBe(200);
    const tokens = (await exchange.json()) as {
      readonly refresh_token: string;
    };

    const refresh = await environment.app.fetch(
      new Request(
        `${OAUTH_ISSUER}/auth/oauth/token`,
        oauthForm({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: tokens.refresh_token,
          scope: "skills:read",
        }),
      ),
    );
    expect(refresh.status).toBe(200);
    const rotated = (await refresh.json()) as {
      readonly access_token: string;
      readonly refresh_token: string;
      readonly scope: string;
    };
    expect(rotated.refresh_token).not.toBe(tokens.refresh_token);
    expect(rotated.scope).toBe("skills:read");
    await expect(
      verifyTestAccessToken(environment, rotated.access_token),
    ).resolves.toMatchObject({
      clientId: client.clientId,
      resource: OAUTH_RESOURCE,
      scopes: ["skills:read"],
    });

    const audit = await environment.services.database.pool.query<{
      event_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, metadata
         FROM control_plane_audit_events
        WHERE user_id = $1
          AND event_type = 'oauth.refresh.rotated'
        ORDER BY occurred_at DESC
        LIMIT 1`,
      [environment.fixture.userId],
    );
    expect(audit.rows[0]).toMatchObject({
      event_type: "oauth.refresh.rotated",
      metadata: {
        resource: OAUTH_RESOURCE,
        scopes: ["skills:read"],
      },
    });
  });

  it("stores no authorization code, access token, or refresh token plaintext", async () => {
    const grant = await environment.authorize(client, "skills:read");
    const exchange = await environment.exchangeCode(grant);
    const tokens = (await exchange.json()) as {
      readonly access_token: string;
      readonly refresh_token: string;
    };
    const columns = await environment.services.database.pool.query<{
      table_name: string;
      column_name: string;
    }>(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name IN (
            'authfn_oauth_authorization_codes',
            'authfn_oauth_access_tokens',
            'authfn_oauth_refresh_tokens'
          )
        ORDER BY table_name, ordinal_position`,
    );
    expect(columns.rows.some((row) => row.column_name === "token")).toBe(false);
    expect(columns.rows.some((row) => row.column_name === "code")).toBe(false);

    const serialized = JSON.stringify(
      await environment.services.database.pool.query(
        `SELECT code_hash AS secret_hash FROM authfn_oauth_authorization_codes
         UNION ALL SELECT token_hash FROM authfn_oauth_access_tokens
         UNION ALL SELECT token_hash FROM authfn_oauth_refresh_tokens
         UNION ALL SELECT registration_access_token_hash
           FROM authfn_oauth_clients
          WHERE registration_access_token_hash IS NOT NULL`,
      ),
    );
    expect(serialized).not.toContain(grant.code);
    expect(serialized).not.toContain(tokens.access_token);
    expect(serialized).not.toContain(tokens.refresh_token);
  });

  it("records consent, refresh, and revocation audit events without secret values", async () => {
    const rows = await environment.services.database.pool.query<{
      event_type: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, metadata
         FROM control_plane_audit_events
        WHERE user_id = $1 AND event_type LIKE 'oauth.%'
        ORDER BY occurred_at, id`,
      [environment.fixture.userId],
    );
    expect(rows.rows.map((row) => row.event_type)).toEqual(
      expect.arrayContaining([
        "oauth.consent.granted",
        "oauth.refresh.rotated",
        "oauth.token.revoked",
      ]),
    );
    expect(JSON.stringify(rows.rows)).not.toMatch(/spo_|spr_|spc_|srr_/);
  });
});
