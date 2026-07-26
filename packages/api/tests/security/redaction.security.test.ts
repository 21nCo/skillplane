import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  TestObjectStorage,
  type TenantFixture,
} from "@skillplane/testing";
import { rollupUtcDay, writeAuditEvent } from "@skillplane/observability";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApiServices, createApiApp, type ApiServices } from "../../src/index.js";

let databaseUrl: string;
let services: ApiServices;
let owner: TenantFixture;
let viewer: TenantFixture;
let outsider: TenantFixture;
let app: ReturnType<typeof createApiApp>;
const suffix = `redaction-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
const viewerSuffix = `${suffix}-viewer`;
const outsiderSuffix = `${suffix}-outsider`;

function headers(
  tenant: TenantFixture,
  workspaceId = owner.workspaceId,
): Record<string, string> {
  return {
    authorization: `Bearer ${tenant.sessionToken}`,
    "x-skillplane-workspace-id": workspaceId,
  };
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  owner = await seedTenantFixture(databaseUrl, suffix);
  viewer = await seedTenantFixture(databaseUrl, viewerSuffix);
  outsider = await seedTenantFixture(databaseUrl, outsiderSuffix);
  services = await buildApiServices({
    RUNTIME_ENV: "local",
    DATABASE_ADAPTER: "postgres",
    DATABASE_URL: databaseUrl,
    SKILL_BUNDLES: new TestObjectStorage(),
  });
  await services.database.pool.query(
    `INSERT INTO workspace_memberships (id, workspace_id, user_id, role)
     VALUES ($1, $2, $3, 'viewer')`,
    [`membership:${suffix}:viewer`, owner.workspaceId, viewer.userId],
  );
  app = createApiApp({
    requestId: () => `request:redaction-api:${crypto.randomUUID()}`,
    getServices: async () => services,
  });

  await writeAuditEvent(services.database.pool, {
    workspaceId: owner.workspaceId,
    eventType: "mcp.skill_retrieve.success",
    action: "skill_retrieve",
    outcome: "success",
    actorType: "service_principal",
    actorId: "service:redaction",
    requestId: `request:redaction:${suffix}`,
    resourceType: "skill_version",
    resourceId: `skill-version:${suffix}`,
    skillId: owner.skillId,
    versionId: `skill-version:${suffix}`,
    contextId: owner.contextId,
    caller: {
      agentId: "agent:security",
      agentName: "Security agent",
      modelProvider: "openai",
      modelName: "gpt-security",
      modelVersion: "2026-07",
      clientName: "security-harness",
      clientVersion: "1",
      runId: "run:redaction",
      sessionId: "session:redaction",
      conversationId: "conversation:redaction",
    },
    credential: {
      kind: "service_principal",
      id: "service:redaction",
    },
    latencyMs: 17.4,
    channel: "mcp",
    retentionClass: "detailed_read_90d",
    metadata: {
      prompt: "Never persist this prompt",
      skillBody: "# Never persist this skill body",
      otp: "123456",
      email: "private@example.test",
      refreshToken: "token-not-for-storage",
      secret: "secret-not-for-storage",
      safeDiagnostic: "retrieval-redaction-verified",
    },
  });
  await rollupUtcDay(services.database.pool, {
    day: new Date().toISOString().slice(0, 10),
    workspaceId: owner.workspaceId,
  });
});

afterAll(async () => {
  await services.datafn.close();
  await services.email?.close();
  await services.database.close();
  await purgeTenantFixture(databaseUrl, suffix);
  await purgeTenantFixture(databaseUrl, viewerSuffix);
  await purgeTenantFixture(databaseUrl, outsiderSuffix);
});

describe("audit redaction and role isolation", () => {
  it("stores controlled diagnostics but never prompt, body, OTP, email, token, or secret values", async () => {
    const stored = await services.database.pool.query<{
      metadata: Record<string, unknown>;
    }>(
      `SELECT metadata FROM audit_events
        WHERE workspace_id = $1 AND request_id = $2`,
      [owner.workspaceId, `request:redaction:${suffix}`],
    );
    const serialized = JSON.stringify(stored.rows[0]?.metadata);
    expect(serialized).toContain("retrieval-redaction-verified");
    for (const prohibited of [
      "Never persist this prompt",
      "Never persist this skill body",
      "123456",
      "private@example.test",
      "token-not-for-storage",
      "secret-not-for-storage",
    ]) {
      expect(serialized).not.toContain(prohibited);
    }
    expect(stored.rows[0]?.metadata).toMatchObject({
      redaction: { removedFieldCount: 6 },
    });

    await expect(
      services.database.pool.query(
        `INSERT INTO audit_events (
           id, workspace_id, event_type, action, outcome, actor_type, actor_id,
           user_id, request_id, metadata, retention_class
         ) VALUES (
           $1, $2, 'unsafe.direct', 'audit:test', 'success', 'user', $3, $3,
           $4, $5, 'permanent'
         )`,
        [
          `audit:unsafe:${suffix}`,
          owner.workspaceId,
          owner.userId,
          `request:unsafe:${suffix}`,
          { nested: { accessToken: "raw-token" } },
        ],
      ),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("allows owner filtering/export, allows viewer aggregates, and denies detailed audit without leakage", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const filter = new URLSearchParams({
      from: today,
      to: today,
      tool: "skill_retrieve",
      outcome: "success",
      agent: "Security agent",
      model: "gpt-security",
      contextId: owner.contextId,
    });
    const ownerList = await app.request(
      `/api/v1/audit/workspaces/${owner.workspaceId}?${filter}`,
      { headers: headers(owner) },
    );
    expect(ownerList.status).toBe(200);
    const ownerText = await ownerList.text();
    expect(ownerText).toContain(`request:redaction:${suffix}`);
    expect(ownerText).toContain('"trust":"authenticated"');
    expect(ownerText).toContain('"trust":"caller-declared"');
    expect(ownerText).not.toContain("private@example.test");

    const exported = await app.request(
      `/api/v1/audit/workspaces/${owner.workspaceId}/export?${filter}`,
      { headers: { ...headers(owner), accept: "text/csv" } },
    );
    expect(exported.status).toBe(200);
    expect(exported.headers.get("content-type")).toContain("text/csv");
    const csv = await exported.text();
    expect(csv).toContain("authenticated_actor_id");
    expect(csv).toContain("declared_caller");
    expect(csv).toContain(`request:redaction:${suffix}`);
    expect(csv).not.toContain("private@example.test");

    const viewerAudit = await app.request(
      `/api/v1/audit/workspaces/${owner.workspaceId}?${filter}`,
      { headers: headers(viewer) },
    );
    expect(viewerAudit.status).toBe(403);
    expect(await viewerAudit.text()).not.toContain(`request:redaction:${suffix}`);

    const analytics = await app.request(
      `/api/v1/analytics/workspaces/${owner.workspaceId}?from=${today}&to=${today}`,
      { headers: headers(viewer) },
    );
    expect(analytics.status).toBe(200);
    const analyticsText = await analytics.text();
    expect(analyticsText).toContain('"retrievalCount":1');
    expect(analyticsText).not.toContain(`request:redaction:${suffix}`);

    const crossTenant = await app.request(
      `/api/v1/audit/workspaces/${owner.workspaceId}?${filter}`,
      { headers: headers(outsider, outsider.workspaceId) },
    );
    expect(crossTenant.status).toBe(404);
    expect(await crossTenant.text()).not.toContain(`request:redaction:${suffix}`);
  });
});
