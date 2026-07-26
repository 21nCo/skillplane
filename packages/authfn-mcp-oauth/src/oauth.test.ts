import type { Pool } from "pg";
import { describe, expect, it } from "vitest";
import {
  authorizationServerMetadata,
  base64Url,
  createOAuthSchema,
  keyedHash,
  MCP_RESOURCE,
  normalizeOAuthConfig,
  OAUTH_SCOPES,
  protectedResourceMetadata,
  protectedResourceChallenge,
  readBearerToken,
  sha256Base64Url,
  signPayload,
  validateClientIdMetadataUrl,
  validateRedirectUri,
  validateRegistration,
  verifySignedPayload,
} from "./index.js";

const pool = {} as Pool;
const pepper = "unit-test-only-oauth-pepper-32-characters";

describe("OAuth 2.1 metadata and configuration", () => {
  it("advertises only the authorization-code, refresh, public-client, and S256 surface", () => {
    const runtime = normalizeOAuthConfig({
      pool,
      issuer: "https://app.skillplane.dev",
      tokenPepper: pepper,
    });
    expect(authorizationServerMetadata(runtime)).toEqual({
      issuer: "https://app.skillplane.dev",
      authorization_endpoint: "https://app.skillplane.dev/auth/oauth/authorize",
      token_endpoint: "https://app.skillplane.dev/auth/oauth/token",
      revocation_endpoint: "https://app.skillplane.dev/auth/oauth/revoke",
      registration_endpoint: "https://app.skillplane.dev/auth/oauth/register",
      scopes_supported: OAUTH_SCOPES,
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none"],
      code_challenge_methods_supported: ["S256"],
      revocation_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
    });
    expect(protectedResourceMetadata(runtime)).toEqual({
      resource: MCP_RESOURCE,
      authorization_servers: ["https://app.skillplane.dev"],
      scopes_supported: OAUTH_SCOPES,
      bearer_methods_supported: ["header"],
      resource_name: "Skillplane MCP",
    });
    expect(
      protectedResourceChallenge(runtime, {
        error: "insufficient_scope",
        scopes: ["skills:read", "not-a-scope"],
      }),
    ).toBe(
      'Bearer resource_metadata="https://mcp.skillplane.dev/.well-known/oauth-protected-resource/mcp", error="insufficient_scope", scope="skills:read"',
    );
  });

  it("enforces maximum code, access, and refresh lifetimes", () => {
    expect(() =>
      normalizeOAuthConfig({
        pool,
        issuer: "https://app.skillplane.dev",
        tokenPepper: pepper,
        authorizationCodeTtlSeconds: 301,
      }),
    ).toThrow(/TTL/);
    expect(() =>
      normalizeOAuthConfig({
        pool,
        issuer: "https://app.skillplane.dev",
        tokenPepper: pepper,
        accessTokenTtlSeconds: 3_601,
      }),
    ).toThrow(/TTL/);
    expect(() =>
      normalizeOAuthConfig({
        pool,
        issuer: "https://app.skillplane.dev",
        tokenPepper: pepper,
        refreshTokenTtlSeconds: 30 * 24 * 60 * 60 + 1,
      }),
    ).toThrow(/TTL/);
  });

  it("exposes every OAuth table through the AuthFn plugin schema contract", () => {
    expect(createOAuthSchema().map((table) => table.modelName)).toEqual([
      "oauth_clients",
      "oauth_client_redirect_uris",
      "oauth_consents",
      "oauth_authorization_requests",
      "oauth_authorization_codes",
      "oauth_access_tokens",
      "oauth_refresh_tokens",
    ]);
  });
});

describe("OAuth client and redirect validation", () => {
  it("accepts exact HTTPS and loopback redirect URIs", () => {
    expect(validateRedirectUri("https://agent.example.test/callback?source=mcp")).toBe(
      "https://agent.example.test/callback?source=mcp",
    );
    expect(validateRedirectUri("http://127.0.0.1:49152/callback")).toBe(
      "http://127.0.0.1:49152/callback",
    );
    expect(validateRedirectUri("http://localhost:49152/callback")).toBe(
      "http://localhost:49152/callback",
    );
  });

  it.each([
    "http://agent.example.test/callback",
    "https://user:password@agent.example.test/callback",
    "https://agent.example.test/callback#fragment",
    "https://*.example.test/callback",
  ])("rejects unsafe redirect URI %s", (redirectUri) => {
    expect(() => validateRedirectUri(redirectUri)).toThrow();
  });

  it.each([
    "https://localhost/client.json",
    "https://127.0.0.1/client.json",
    "https://10.0.0.8/client.json",
    "https://metadata.internal/client.json",
    "https://agent.example.test/",
    "https://agent.example.test/client.json?version=1",
  ])("rejects unsafe client metadata URL %s", (clientId) => {
    expect(() => validateClientIdMetadataUrl(clientId)).toThrow();
  });

  it("rejects confidential, implicit, password, and unknown-scope registration", () => {
    const base = {
      client_name: "Review Agent",
      redirect_uris: ["https://agent.example.test/callback"],
    };
    expect(() =>
      validateRegistration({
        ...base,
        token_endpoint_auth_method: "client_secret_basic",
      }),
    ).toThrow(/public/);
    expect(() => validateRegistration({ ...base, response_types: ["token"] })).toThrow(
      /code/,
    );
    expect(() => validateRegistration({ ...base, grant_types: ["password"] })).toThrow(
      /grant/,
    );
    expect(() =>
      validateRegistration({ ...base, scope: "skills:read admin:all" }),
    ).toThrow(/scope/);
  });
});

describe("opaque token primitives", () => {
  it("uses keyed hashes and tamper-evident request preservation", () => {
    const secret = `spo_${base64Url(new Uint8Array(32).fill(7))}`;
    const digest = keyedHash(secret, pepper);
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
    expect(digest).not.toContain(secret);
    const signed = signPayload('{"request":"one"}', pepper);
    expect(verifySignedPayload(signed, pepper)).toBe('{"request":"one"}');
    expect(verifySignedPayload(`${signed}x`, pepper)).toBeNull();
  });

  it("produces the RFC 7636 S256 challenge vector", () => {
    expect(sha256Base64Url("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("accepts bearer tokens only in the authorization header", () => {
    expect(
      readBearerToken(
        new Request("https://mcp.skillplane.dev/mcp", {
          headers: { authorization: "Bearer spo_example" },
        }),
      ),
    ).toBe("spo_example");
    expect(() =>
      readBearerToken(
        new Request("https://mcp.skillplane.dev/mcp?access_token=spo_example"),
      ),
    ).toThrow(/query/);
  });
});
