import { AUTH_CSRF_HEADER } from "@skillplane/auth";
import {
  purgeTenantFixture,
  seedTenantFixture,
  type TenantFixture,
} from "@skillplane/testing";
import type { PoolClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  OAUTH_ISSUER,
  OAUTH_RESOURCE,
  oauthForm,
  sessionCookie,
  startOAuthTestEnvironment,
  verifyTestAccessToken,
  type OAuthGrant,
  type OAuthTestEnvironment,
  type OAuthTestUser,
  type RegisteredTestClient,
} from "../support/oauth-test-environment.test.support.js";

interface TokenPair {
  readonly access_token: string;
  readonly refresh_token: string;
}

interface Connection {
  readonly consentId: string;
  readonly clientId: string;
  readonly clientName: string;
  readonly resource: string;
  readonly scopes: readonly string[];
  readonly grantedAt: string;
  readonly lastTokenIssuedAt: string | null;
}

const CONNECTIONS = `${OAUTH_ISSUER}/api/v1/me/oauth-connections`;

describe("OAuth connection listing and revocation", () => {
  let environment: OAuthTestEnvironment;
  let owner: OAuthTestUser;
  let otherFixture: TenantFixture;
  let other: OAuthTestUser;
  const otherSuffix = `oauth-connections-other-${crypto.randomUUID().slice(0, 8)}`;

  beforeAll(async () => {
    environment = await startOAuthTestEnvironment("connections");
    owner = { cookie: environment.cookie, csrfToken: environment.fixture.csrfToken };
    otherFixture = await seedTenantFixture(environment.databaseUrl, otherSuffix);
    other = { cookie: sessionCookie(otherFixture), csrfToken: otherFixture.csrfToken };
  });

  afterAll(async () => {
    await environment.close();
    await purgeTenantFixture(environment.databaseUrl, otherSuffix);
  });

  async function connect(
    client: RegisteredTestClient,
    as: OAuthTestUser = owner,
  ): Promise<TokenPair> {
    const grant = await environment.authorize(client, "skills:read", as);
    const exchange = await environment.exchangeCode(grant);
    expect(exchange.status, await exchange.clone().text()).toBe(200);
    return (await exchange.json()) as TokenPair;
  }

  function refresh(client: RegisteredTestClient, token: string): Promise<Response> {
    return environment.app.fetch(
      new Request(
        `${OAUTH_ISSUER}/auth/oauth/token`,
        oauthForm({
          grant_type: "refresh_token",
          client_id: client.clientId,
          refresh_token: token,
          resource: OAUTH_RESOURCE,
        }),
      ),
    );
  }

  async function list(as: OAuthTestUser = owner): Promise<Connection[]> {
    const response = await environment.app.fetch(
      new Request(CONNECTIONS, { headers: { cookie: as.cookie } }),
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const body = (await response.json()) as {
      readonly data: { readonly connections: Connection[] };
    };
    return body.data.connections;
  }

  function revoke(consentId: string, as: OAuthTestUser = owner): Promise<Response> {
    return environment.app.fetch(
      new Request(`${CONNECTIONS}/${encodeURIComponent(consentId)}`, {
        method: "DELETE",
        headers: { cookie: as.cookie, [AUTH_CSRF_HEADER]: as.csrfToken },
      }),
    );
  }

  async function consentFor(
    client: RegisteredTestClient,
    as: OAuthTestUser = owner,
  ): Promise<Connection> {
    const connection = (await list(as)).find(
      (entry) => entry.clientId === client.clientId,
    );
    if (!connection) throw new Error(`No connection for ${client.clientId}`);
    return connection;
  }

  async function consentRevokedAt(consentId: string): Promise<Date | null> {
    const result = await environment.services.database.pool.query<{
      revoked_at: Date | null;
    }>("SELECT revoked_at FROM authfn_oauth_consents WHERE id = $1", [consentId]);
    return result.rows[0]?.revoked_at ?? null;
  }

  async function revocationAudits(consentId: string) {
    const result = await environment.services.database.pool.query<{
      event_type: string;
      resource_type: string;
      resource_id: string;
      metadata: Record<string, unknown>;
    }>(
      `SELECT event_type, resource_type, resource_id, metadata
         FROM control_plane_audit_events
        WHERE event_type = 'oauth.consent.revoked'
          AND metadata->>'consentId' = $1`,
      [consentId],
    );
    return result.rows;
  }

  it("lists only the caller's active consents with client and token details", async () => {
    const client = await environment.registerClient({ name: "Listing Agent" });
    await connect(client);
    await connect(client, other);

    const mine = await list();
    const entry = mine.find((connection) => connection.clientId === client.clientId);
    expect(entry).toMatchObject({
      consentId: expect.stringMatching(/^ocn_/u),
      clientName: "Listing Agent",
      resource: OAUTH_RESOURCE,
      scopes: ["skills:read"],
    });
    expect(Date.parse(entry?.grantedAt ?? "")).not.toBeNaN();
    expect(Date.parse(entry?.lastTokenIssuedAt ?? "")).not.toBeNaN();

    const theirs = await consentFor(client, other);
    expect(theirs.consentId).not.toBe(entry?.consentId);
    expect(mine.map((connection) => connection.consentId)).not.toContain(
      theirs.consentId,
    );
    expect(JSON.stringify(mine)).not.toMatch(/spo_|spr_|spc_/u);
  });

  it("revokes the consent and every token family the user holds for the client", async () => {
    const client = await environment.registerClient({ name: "Revoked Agent" });
    const first = await connect(client);
    const second = await connect(client);
    const othersTokens = await connect(client, other);
    const unrelated = await connect(
      await environment.registerClient({ name: "Unrelated Agent" }),
    );
    const consent = await consentFor(client);
    // An access-only RFC 7009 revoke leaves that family's refresh token live;
    // the consent sweep must still reach it.
    const accessOnly = await environment.app.fetch(
      new Request(
        `${OAUTH_ISSUER}/auth/oauth/revoke`,
        oauthForm({
          client_id: client.clientId,
          token: first.access_token,
          token_type_hint: "access_token",
        }),
      ),
    );
    expect(accessOnly.status).toBe(200);

    const response = await revoke(consent.consentId);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");

    for (const tokens of [first, second]) {
      await expect(
        verifyTestAccessToken(environment, tokens.access_token),
      ).rejects.toMatchObject({ code: "invalid_grant", status: 401 });
      const refreshed = await refresh(client, tokens.refresh_token);
      expect(refreshed.status).toBe(400);
      await expect(refreshed.json()).resolves.toMatchObject({ error: "invalid_grant" });
    }
    // The refresh grant also refuses a revoked consent, so check the rows.
    const liveRefresh = await environment.services.database.pool.query(
      `SELECT id FROM authfn_oauth_refresh_tokens
        WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL`,
      [environment.fixture.userId, client.clientId],
    );
    expect(liveRefresh.rows).toEqual([]);
    expect(await consentRevokedAt(consent.consentId)).toBeInstanceOf(Date);
    expect((await list()).map((entry) => entry.consentId)).not.toContain(
      consent.consentId,
    );

    // Another user's grant to the same client and this user's other clients stay.
    await expect(
      verifyTestAccessToken(environment, othersTokens.access_token),
    ).resolves.toMatchObject({ userId: otherFixture.userId });
    await expect(
      verifyTestAccessToken(environment, unrelated.access_token),
    ).resolves.toMatchObject({ userId: environment.fixture.userId });
    expect((await refresh(client, othersTokens.refresh_token)).status).toBe(200);

    const audits = await revocationAudits(consent.consentId);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      resource_type: "oauth_client",
      resource_id: client.clientId,
      metadata: {
        consentId: consent.consentId,
        clientId: client.clientId,
        resource: OAUTH_RESOURCE,
        revokedGrants: { codes: 0, access: 1, refresh: 2 },
      },
    });
    const serialized = JSON.stringify(audits);
    for (const secret of [
      first.access_token,
      first.refresh_token,
      second.refresh_token,
    ])
      expect(serialized).not.toContain(secret);
    expect(serialized).not.toMatch(/spo_|spr_|spc_|[a-f0-9]{64}/u);
  });

  it("refuses an authorization code issued before the revocation", async () => {
    const client = await environment.registerClient({ name: "Pending Code Agent" });
    await connect(client);
    const pending: OAuthGrant = await environment.authorize(client, "skills:read");
    const consent = await consentFor(client);

    expect((await revoke(consent.consentId)).status).toBe(204);
    const exchange = await environment.exchangeCode(pending);
    expect(exchange.status).toBe(400);
    await expect(exchange.json()).resolves.toMatchObject({ error: "invalid_grant" });

    // Granting again restores the connection with new tokens.
    const renewed = await connect(client);
    await expect(
      verifyTestAccessToken(environment, renewed.access_token),
    ).resolves.toMatchObject({ clientId: client.clientId });
  });

  it("returns 404 for another user's or an unknown consent and changes nothing", async () => {
    const client = await environment.registerClient({ name: "Foreign Agent" });
    const theirs = await connect(client, other);
    const foreign = await consentFor(client, other);

    for (const consentId of [
      foreign.consentId,
      "ocn_AAAAAAAAAAAAAAAAAAAAAAAA",
      "not-a-consent",
      `${foreign.consentId}%00`,
    ]) {
      const response = await revoke(consentId);
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toMatchObject({
        ok: false,
        error: { code: "NOT_FOUND" },
      });
    }
    expect(await consentRevokedAt(foreign.consentId)).toBeNull();
    await expect(
      verifyTestAccessToken(environment, theirs.access_token),
    ).resolves.toMatchObject({ userId: otherFixture.userId });
    expect(await revocationAudits(foreign.consentId)).toHaveLength(0);
  });

  it("answers a repeated or racing revocation with 204 and one state change", async () => {
    const client = await environment.registerClient({ name: "Racing Agent" });
    await connect(client);
    const consent = await consentFor(client);

    const raced = await Promise.all([
      revoke(consent.consentId),
      revoke(consent.consentId),
    ]);
    expect(raced.map((response) => response.status)).toEqual([204, 204]);
    const revokedAt = await consentRevokedAt(consent.consentId);
    expect(revokedAt).toBeInstanceOf(Date);

    expect((await revoke(consent.consentId)).status).toBe(204);
    expect(await consentRevokedAt(consent.consentId)).toEqual(revokedAt);
    expect(await revocationAudits(consent.consentId)).toHaveLength(1);
  });

  // Counts only sessions queued behind this test's blocker, directly or through
  // another waiter (the consent revoke waits on the in-flight request that
  // holds the consent share lock), so lock waits from other test files that
  // share the database cannot release the blocker early.
  async function waitForLockWaiters(blocker: PoolClient, count: number): Promise<void> {
    const pid = await blocker.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const blockerPid = pid.rows[0]?.pid;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const result = await environment.services.database.pool.query<{
        waiting: string;
      }>(
        `WITH RECURSIVE chain(pid) AS (
           SELECT $1::int
           UNION
           SELECT activity.pid
             FROM pg_stat_activity AS activity
             JOIN chain ON chain.pid = ANY(pg_blocking_pids(activity.pid))
         )
         SELECT count(*) - 1 AS waiting FROM chain`,
        [blockerPid],
      );
      if (Number(result.rows[0]?.waiting) >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`Timed out waiting for ${String(count)} lock waiters`);
  }

  it("revokes tokens minted by a refresh that was already in flight", async () => {
    const client = await environment.registerClient({ name: "In-flight Agent" });
    const tokens = await connect(client);
    const consent = await consentFor(client);
    const blocker = await environment.services.database.pool.connect();
    try {
      // Hold the refresh token row so the refresh stops after taking its
      // consent share lock, which is what an in-flight rotation looks like.
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM authfn_oauth_refresh_tokens
          WHERE user_id = $1 AND client_id = $2
          FOR UPDATE`,
        [environment.fixture.userId, client.clientId],
      );
      const rotation = refresh(client, tokens.refresh_token);
      await waitForLockWaiters(blocker, 1);
      const revocation = revoke(consent.consentId);
      await waitForLockWaiters(blocker, 2);
      await blocker.query("ROLLBACK");

      const rotated = await rotation;
      expect(rotated.status).toBe(200);
      const minted = (await rotated.json()) as TokenPair;
      expect((await revocation).status).toBe(204);

      await expect(
        verifyTestAccessToken(environment, minted.access_token),
      ).rejects.toMatchObject({ code: "invalid_grant", status: 401 });
      expect((await refresh(client, minted.refresh_token)).status).toBe(400);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });

  it("completes a consent revoke racing the client's own RFC 7009 revoke", async () => {
    const client = await environment.registerClient({ name: "Self-revoking Agent" });
    const first = await connect(client);
    const rotated = await refresh(client, first.refresh_token);
    expect(rotated.status).toBe(200);
    const current = (await rotated.json()) as TokenPair;
    const consent = await consentFor(client);
    const blocker = await environment.services.database.pool.connect();
    try {
      // Hold the current refresh token so /oauth/revoke queues on it first.
      // Without a shared consent lock order, the consent sweep then locks the
      // consumed parent and waits on this row while the family revoke waits on
      // the parent, and Postgres aborts one side with a deadlock.
      await blocker.query("BEGIN");
      await blocker.query(
        `SELECT id FROM authfn_oauth_refresh_tokens
          WHERE user_id = $1 AND client_id = $2 AND consumed_at IS NULL
          FOR UPDATE`,
        [environment.fixture.userId, client.clientId],
      );
      const clientRevocation = environment.app.fetch(
        new Request(
          `${OAUTH_ISSUER}/auth/oauth/revoke`,
          oauthForm({
            client_id: client.clientId,
            token: current.refresh_token,
            token_type_hint: "refresh_token",
          }),
        ),
      );
      await waitForLockWaiters(blocker, 1);
      const consentRevocation = revoke(consent.consentId);
      await waitForLockWaiters(blocker, 2);
      await blocker.query("ROLLBACK");

      expect((await clientRevocation).status).toBe(200);
      expect((await consentRevocation).status).toBe(204);
      expect(await consentRevokedAt(consent.consentId)).toBeInstanceOf(Date);
      expect(await revocationAudits(consent.consentId)).toHaveLength(1);
      const live = await environment.services.database.pool.query<{
        live: string;
      }>(
        `SELECT (SELECT count(*) FROM authfn_oauth_refresh_tokens
                  WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL)
              + (SELECT count(*) FROM authfn_oauth_access_tokens
                  WHERE user_id = $1 AND client_id = $2 AND revoked_at IS NULL)
                AS live`,
        [environment.fixture.userId, client.clientId],
      );
      expect(Number(live.rows[0]?.live)).toBe(0);
    } finally {
      await blocker.query("ROLLBACK").catch(() => undefined);
      blocker.release();
    }
  });
});
