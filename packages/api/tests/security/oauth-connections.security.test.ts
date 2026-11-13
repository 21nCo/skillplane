import { AUTH_CSRF_COOKIE, AUTH_CSRF_HEADER } from "@skillplane/auth";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rateLimitRouteKey } from "../../src/middleware/rate-limit.js";
import {
  OAUTH_ISSUER,
  startOAuthTestEnvironment,
  verifyTestAccessToken,
  type OAuthTestEnvironment,
} from "../support/oauth-test-environment.test.support.js";

const CONNECTIONS = `${OAUTH_ISSUER}/api/v1/me/oauth-connections`;

describe("OAuth connection route defenses", () => {
  let environment: OAuthTestEnvironment;
  let consentId: string;
  let accessToken: string;
  let serviceCredential: string;

  beforeAll(async () => {
    environment = await startOAuthTestEnvironment("connections-security");
    const client = await environment.registerClient({ name: "Defended Agent" });
    const exchange = await environment.exchangeCode(
      await environment.authorize(client, "skills:read"),
    );
    accessToken = ((await exchange.json()) as { readonly access_token: string })
      .access_token;
    const consent = await environment.services.database.pool.query<{ id: string }>(
      "SELECT id FROM authfn_oauth_consents WHERE user_id = $1 AND client_id = $2",
      [environment.fixture.userId, client.clientId],
    );
    consentId = consent.rows[0]?.id ?? "";
    // A credential delegated to the very user who granted the consent.
    const created = await environment.app.fetch(
      new Request(
        `${OAUTH_ISSUER}/api/v1/workspaces/${environment.fixture.workspaceId}/service-principals`,
        {
          method: "POST",
          headers: {
            cookie: environment.cookie,
            [AUTH_CSRF_HEADER]: environment.fixture.csrfToken,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            name: "connections-security",
            role: "editor",
            scopes: ["skills:read"],
            delegatedUserId: environment.fixture.userId,
          }),
        },
      ),
    );
    expect(created.status, await created.clone().text()).toBe(201);
    serviceCredential = (
      (await created.json()) as { readonly data: { readonly credential: string } }
    ).data.credential;
  });

  afterAll(async () => {
    await environment.close();
  });

  async function assertUnchanged(): Promise<void> {
    const consent = await environment.services.database.pool.query<{
      revoked_at: Date | null;
    }>("SELECT revoked_at FROM authfn_oauth_consents WHERE id = $1", [consentId]);
    expect(consent.rows[0]?.revoked_at).toBeNull();
    await expect(
      verifyTestAccessToken(environment, accessToken),
    ).resolves.toMatchObject({ userId: environment.fixture.userId });
  }

  it.each([
    ["missing", undefined],
    ["wrong", "not-the-csrf-token"],
  ])("rejects a revocation with a %s CSRF header", async (_name, header) => {
    const response = await environment.app.fetch(
      new Request(`${CONNECTIONS}/${consentId}`, {
        method: "DELETE",
        headers: {
          cookie: environment.cookie,
          ...(header ? { [AUTH_CSRF_HEADER]: header } : {}),
        },
      }),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_CSRF_INVALID" },
    });
    await assertUnchanged();
  });

  it("rejects a service-principal API key even when delegated to the same user", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await environment.app.fetch(
        new Request(method === "GET" ? CONNECTIONS : `${CONNECTIONS}/${consentId}`, {
          method,
          headers: { authorization: `Bearer ${serviceCredential}` },
        }),
      );
      expect(response.status).toBe(403);
      const text = await response.text();
      expect(text).not.toContain(consentId);
      expect(text).not.toContain(serviceCredential);
    }
    await assertUnchanged();
  });

  it("rejects a bearer session without the browser cookie that CSRF protects", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await environment.app.fetch(
        new Request(method === "GET" ? CONNECTIONS : `${CONNECTIONS}/${consentId}`, {
          method,
          headers: {
            authorization: `Bearer ${environment.fixture.sessionToken}`,
            cookie: `${AUTH_CSRF_COOKIE}=${environment.fixture.csrfToken}`,
            [AUTH_CSRF_HEADER]: environment.fixture.csrfToken,
          },
        }),
      );
      expect(response.status).toBe(403);
      expect(await response.text()).not.toContain(consentId);
    }
    await assertUnchanged();
  });

  it("requires authentication", async () => {
    for (const method of ["GET", "DELETE"] as const) {
      const response = await environment.app.fetch(
        new Request(method === "GET" ? CONNECTIONS : `${CONNECTIONS}/${consentId}`, {
          method,
        }),
      );
      expect(response.status).toBe(401);
    }
    await assertUnchanged();
  });

  it("shares one rate-limit bucket across guessed consent IDs", () => {
    expect(rateLimitRouteKey(`/api/v1/me/oauth-connections/${consentId}`)).toBe(
      "/api/v1/me/oauth-connections/:consentId",
    );
    expect(rateLimitRouteKey("/api/v1/me/oauth-connections/ocn_guess")).toBe(
      "/api/v1/me/oauth-connections/:consentId",
    );
  });
});
