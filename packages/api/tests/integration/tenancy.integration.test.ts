import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";
import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let databaseUrl: string;
let services: ApiServices;
let owner: TenantFixture;
let recipient: TenantFixture;
let outsider: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const messages: unknown[] = [];
const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
const ownerSuffix = `tenancy-owner-${suffix}`;
const recipientSuffix = `tenancy-recipient-${suffix}`;
const outsiderSuffix = `tenancy-outsider-${suffix}`;

function headers(fixture: TenantFixture, workspaceId?: string): Record<string, string> {
  return {
    authorization: `Bearer ${fixture.sessionToken}`,
    ...(workspaceId ? { "x-skillplane-workspace-id": workspaceId } : {}),
  };
}

async function json<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, ownerSuffix);
  recipient = await seedTenantFixture(databaseUrl, recipientSuffix);
  outsider = await seedTenantFixture(databaseUrl, outsiderSuffix);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    AUTH_MODE: "otp",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
    EMAIL_PROVIDER: "cloudflare-email",
    AUTHFN_SECRET: "tenancy-integration-authfn-secret-32-characters",
    TURNSTILE_SECRET_KEY: "tenancy-integration-turnstile-secret-value",
    TURNSTILE_ALLOWED_HOSTNAMES: "localhost",
    PUBLIC_TURNSTILE_SITE_KEY: "tenancy-integration-site-key",
    SKILLPLANE_OTP_FROM: "Skillplane <no-reply@auth.skillplane.dev>",
    SEND_EMAIL: {
      send(message) {
        messages.push(message);
        return Promise.resolve({ messageId: `cf_tenancy_${messages.length}` });
      },
    },
  });
  app = createApiApp({
    requestId: () => "req_tenancy",
    getServices: async () => services,
  });
});

afterAll(async () => {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const users = [owner.userId, recipient.userId, outsider.userId];
    await pool.query(
      "DELETE FROM workspaces WHERE personal_owner_user_id = ANY($1::text[])",
      [users],
    );
  } finally {
    await pool.end();
  }
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, ownerSuffix);
  await purgeTenantFixture(databaseUrl, recipientSuffix);
  await purgeTenantFixture(databaseUrl, outsiderSuffix);
});

describe("tenancy integration", () => {
  let organizationId: string;
  let invitationToken: string;
  let serviceCredential: string;
  let servicePrincipalId: string;

  it("bootstraps exactly one personal workspace under concurrent requests", async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        app.request("/api/v1/workspaces", { headers: headers(owner) }),
      ),
    );
    expect(responses.every((response) => response.status === 200)).toBe(true);
    const count = await services.database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM workspaces
        WHERE kind = 'personal' AND personal_owner_user_id = $1`,
      [owner.userId],
    );
    expect(count.rows[0]?.count).toBe("1");
  });

  it("creates an organization and preserves the final-owner invariant", async () => {
    const created = await app.request("/api/v1/workspaces", {
      method: "POST",
      headers: {
        ...headers(owner),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: `Tenancy ${suffix}`,
        slug: `tenancy-${suffix}`,
      }),
    });
    expect(created.status).toBe(201);
    const body = await json<{
      data: { workspace: { id: string; role: string } };
    }>(created);
    organizationId = body.data.workspace.id;
    expect(body.data.workspace.role).toBe("owner");

    const removal = await app.request(
      `/api/v1/workspaces/${organizationId}/members/${owner.userId}`,
      {
        method: "DELETE",
        headers: headers(owner),
      },
    );
    expect(removal.status).toBe(403);
    expect(await removal.text()).toContain("WORKSPACE_FORBIDDEN");
    const membership = await services.database.pool.query(
      `SELECT 1 FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2 AND role = 'owner'`,
      [organizationId, owner.userId],
    );
    expect(membership.rowCount).toBe(1);
  });

  it("delivers an encrypted, hashed, role-scoped invitation", async () => {
    const response = await app.request(
      `/api/v1/workspaces/${organizationId}/invitations`,
      {
        method: "POST",
        headers: {
          ...headers(owner),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: `${recipientSuffix}@example.test`,
          role: "editor",
        }),
      },
    );
    expect(response.status).toBe(201);
    const serializedResponse = await response.text();
    expect(serializedResponse).not.toContain("spi_");

    const serializedMessage = JSON.stringify(messages.at(-1));
    const tokenMatch = serializedMessage.match(/invitations\/(spi_[A-Za-z0-9_-]+)/u);
    const deliveredToken = tokenMatch?.[1];
    expect(deliveredToken).toBeDefined();
    if (!deliveredToken) throw new Error("Invitation token was not delivered");
    invitationToken = deliveredToken;

    const persisted = await services.database.pool.query<{
      email_ciphertext: string;
      email_hash: string;
      token_hash: string;
    }>(
      `SELECT email_ciphertext, email_hash, token_hash
         FROM workspace_invitations
        WHERE workspace_id = $1`,
      [organizationId],
    );
    const row = persisted.rows[0];
    if (!row) throw new Error("Invitation was not persisted");
    expect(row.email_ciphertext).toMatch(/^v1\./u);
    expect(row.email_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(row.token_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(row)).not.toContain(`${recipientSuffix}@example.test`);
    expect(JSON.stringify(row)).not.toContain(invitationToken);
  });

  it("serializes concurrent invitations for the same normalized recipient", async () => {
    const before = messages.length;
    const request = () =>
      app.request(`/api/v1/workspaces/${organizationId}/invitations`, {
        method: "POST",
        headers: {
          ...headers(owner),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: ` ${outsiderSuffix.toUpperCase()}@EXAMPLE.TEST `,
          role: "viewer",
        }),
      });
    const results = await Promise.all([request(), request()]);
    expect(results.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(messages).toHaveLength(before + 1);
  });

  it("rejects identity mismatch, accepts once, and persists the requested role", async () => {
    const mismatch = await app.request(`/api/v1/invitations/${invitationToken}`, {
      headers: headers(outsider),
    });
    expect(mismatch.status).toBe(403);
    expect(await mismatch.text()).toContain("INVITATION_EMAIL_MISMATCH");

    const accepted = await app.request(
      `/api/v1/invitations/${invitationToken}/accept`,
      {
        method: "POST",
        headers: headers(recipient),
      },
    );
    expect(accepted.status).toBe(200);
    const membership = await services.database.pool.query<{ role: string }>(
      `SELECT role FROM workspace_memberships
        WHERE workspace_id = $1 AND user_id = $2`,
      [organizationId, recipient.userId],
    );
    expect(membership.rows[0]?.role).toBe("editor");

    const reused = await app.request(`/api/v1/invitations/${invitationToken}/accept`, {
      method: "POST",
      headers: headers(recipient),
    });
    expect(reused.status).toBe(409);
    expect(await reused.text()).toContain("INVITATION_USED");
  });

  it("enforces role hierarchy for membership changes", async () => {
    const editorPromotesSelf = await app.request(
      `/api/v1/workspaces/${organizationId}/members/${recipient.userId}`,
      {
        method: "PATCH",
        headers: {
          ...headers(recipient),
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    expect(editorPromotesSelf.status).toBe(403);
    expect(await editorPromotesSelf.text()).toContain("WORKSPACE_FORBIDDEN");

    const ownerPromotes = await app.request(
      `/api/v1/workspaces/${organizationId}/members/${recipient.userId}`,
      {
        method: "PATCH",
        headers: {
          ...headers(owner),
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "admin" }),
      },
    );
    expect(ownerPromotes.status).toBe(200);
  });

  it("issues a one-time service secret and revokes it immediately", async () => {
    const created = await app.request(
      `/api/v1/workspaces/${organizationId}/service-principals`,
      {
        method: "POST",
        headers: {
          ...headers(owner),
          "content-type": "application/json",
        },
        body: JSON.stringify({
          name: `review-agent-${suffix}`,
          role: "admin",
          scopes: ["skills:read", "skills:amend"],
        }),
      },
    );
    expect(created.status).toBe(201);
    const body = await json<{
      data: {
        credential: string;
        servicePrincipal: { id: string };
      };
    }>(created);
    serviceCredential = body.data.credential;
    servicePrincipalId = body.data.servicePrincipal.id;
    expect(serviceCredential).toMatch(/^sps_[A-Za-z0-9_-]+$/u);

    const listing = await app.request(
      `/api/v1/workspaces/${organizationId}/service-principals`,
      { headers: headers(owner) },
    );
    const serializedListing = await listing.text();
    expect(serializedListing).not.toContain(serviceCredential);
    expect(serializedListing).not.toContain("credentialHash");

    const persisted = await services.database.pool.query<{
      credential_hash: string;
    }>("SELECT credential_hash FROM service_principals WHERE id = $1", [
      servicePrincipalId,
    ]);
    expect(persisted.rows[0]?.credential_hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(persisted.rows[0]?.credential_hash).not.toBe(serviceCredential);

    const access = await app.request("/api/v1/skills/search?q=review", {
      headers: {
        authorization: `Bearer ${serviceCredential}`,
        "x-skillplane-workspace-id": organizationId,
      },
    });
    expect(access.status).toBe(200);

    const overScoped = await app.request("/api/v1/audit", {
      headers: {
        authorization: `Bearer ${serviceCredential}`,
        "x-skillplane-workspace-id": organizationId,
      },
    });
    expect(overScoped.status).toBe(403);
    expect(await overScoped.text()).toContain("AUTH_SCOPE_REQUIRED");

    const rotated = await app.request(
      `/api/v1/workspaces/${organizationId}/service-principals/${servicePrincipalId}/rotate`,
      {
        method: "POST",
        headers: {
          ...headers(owner),
          "content-type": "application/json",
        },
        body: "{}",
      },
    );
    expect(rotated.status).toBe(200);
    const rotation = await json<{ data: { credential: string } }>(rotated);
    const replacementCredential = rotation.data.credential;
    expect(replacementCredential).toMatch(/^sps_/u);
    expect(replacementCredential).not.toBe(serviceCredential);

    const oldDenied = await app.request("/api/v1/skills/search?q=review", {
      headers: {
        authorization: `Bearer ${serviceCredential}`,
        "x-skillplane-workspace-id": organizationId,
      },
    });
    expect(oldDenied.status).toBe(401);

    serviceCredential = replacementCredential;
    const replacementAccess = await app.request("/api/v1/skills/search?q=review", {
      headers: {
        authorization: `Bearer ${serviceCredential}`,
        "x-skillplane-workspace-id": organizationId,
      },
    });
    expect(replacementAccess.status).toBe(200);

    const revoked = await app.request(
      `/api/v1/workspaces/${organizationId}/service-principals/${servicePrincipalId}`,
      {
        method: "DELETE",
        headers: headers(owner),
      },
    );
    expect(revoked.status).toBe(200);

    const denied = await app.request("/api/v1/skills/search?q=review", {
      headers: {
        authorization: `Bearer ${serviceCredential}`,
        "x-skillplane-workspace-id": organizationId,
      },
    });
    expect(denied.status).toBe(401);
    expect(await denied.text()).toContain("SERVICE_PRINCIPAL_INVALID");
  });

  it("serializes concurrent owner removals so one owner always remains", async () => {
    const promoted = await app.request(
      `/api/v1/workspaces/${organizationId}/members/${recipient.userId}`,
      {
        method: "PATCH",
        headers: {
          ...headers(owner),
          "content-type": "application/json",
        },
        body: JSON.stringify({ role: "owner" }),
      },
    );
    expect(promoted.status).toBe(200);

    const [ownerRemoval, recipientRemoval] = await Promise.all([
      app.request(`/api/v1/workspaces/${organizationId}/members/${owner.userId}`, {
        method: "DELETE",
        headers: headers(owner),
      }),
      app.request(`/api/v1/workspaces/${organizationId}/members/${recipient.userId}`, {
        method: "DELETE",
        headers: headers(recipient),
      }),
    ]);
    expect([ownerRemoval.status, recipientRemoval.status].sort()).toEqual([200, 403]);
    const remaining = await services.database.pool.query<{
      owners: string;
    }>(
      `SELECT count(*)::text AS owners
         FROM workspace_memberships
        WHERE workspace_id = $1 AND role = 'owner'`,
      [organizationId],
    );
    expect(remaining.rows[0]?.owners).toBe("1");
  });
});
