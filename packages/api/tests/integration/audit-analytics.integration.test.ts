import { migrateDatabase, resolveTestDatabaseUrl } from "@skillplane/db";
import {
  purgeTenantFixture,
  seedTenantFixture,
  type TenantFixture,
} from "@skillplane/testing";
import {
  rollupUtcDay,
  runAuditRetention,
  writeAuditEvent,
} from "@skillplane/observability";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let databaseUrl: string;
let pool: Pool;
let tenant: TenantFixture;
const suffix = `audit-analytics-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;

function daysAgo(days: number, hour = 12): Date {
  const value = new Date(Date.now() - days * 86_400_000);
  value.setUTCHours(hour, 0, 0, 0);
  return value;
}

function day(value: Date): string {
  return value.toISOString().slice(0, 10);
}

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
  tenant = await seedTenantFixture(databaseUrl, suffix);
  pool = new Pool({
    connectionString: databaseUrl,
    application_name: `audit-analytics-${suffix}`,
    max: 4,
  });
});

afterAll(async () => {
  await pool.end();
  await purgeTenantFixture(databaseUrl, suffix);
});

describe("audit retention and analytics rollups", () => {
  it("rebuilds a UTC day idempotently and retains aggregates after detail expiry", async () => {
    const retrievalAt = daysAgo(91);
    const mutationAt = daysAgo(400);
    for (let index = 0; index < 10; index += 1) {
      await writeAuditEvent(pool, {
        workspaceId: tenant.workspaceId,
        eventType: "mcp.skill_retrieve.success",
        action: "skill_retrieve",
        outcome: "success",
        actorType: "service_principal",
        actorId: "service:analytics-agent",
        requestId: `request:retrieval:${suffix}:${String(index)}`,
        resourceType: "skill_version",
        resourceId: `skill-version:${suffix}`,
        skillId: tenant.skillId,
        versionId: `skill-version:${suffix}`,
        contextId: tenant.contextId,
        agent: "Codex",
        model: "gpt-5",
        caller: {
          agentId: "agent:codex",
          agentName: "Codex",
          modelProvider: "openai",
          modelName: "gpt-5",
          modelVersion: "2026-07",
          clientName: "zed",
          clientVersion: "1.0",
          runId: `run:${String(index)}`,
          sessionId: "session:analytics",
          conversationId: "conversation:analytics",
        },
        latencyMs: 10 + index,
        channel: "mcp",
        retentionClass: "detailed_read_90d",
        occurredAt: retrievalAt,
      });
    }
    for (let index = 0; index < 2; index += 1) {
      await writeAuditEvent(pool, {
        workspaceId: tenant.workspaceId,
        eventType: "skill.amendment.created",
        action: "skills:amend",
        outcome: "success",
        actorType: "service_principal",
        actorId: "service:analytics-agent",
        requestId: `request:amendment:${suffix}:${String(index)}`,
        resourceType: "skill_version",
        resourceId: `candidate:${index}`,
        skillId: tenant.skillId,
        versionId: `candidate:${index}`,
        channel: "mcp",
        retentionClass: "permanent",
        occurredAt: mutationAt,
      });
    }
    await writeAuditEvent(pool, {
      workspaceId: tenant.workspaceId,
      eventType: "oauth.refresh.reuse_detected",
      action: "oauth:refresh",
      outcome: "denied",
      actorType: "user",
      actorId: tenant.userId,
      userId: tenant.userId,
      requestId: `request:reuse:${suffix}`,
      resourceType: "oauth_client",
      resourceId: "client:analytics",
      channel: "oauth",
      retentionClass: "permanent",
      occurredAt: mutationAt,
    });

    const first = await rollupUtcDay(pool, {
      day: day(retrievalAt),
      workspaceId: tenant.workspaceId,
    });
    const second = await rollupUtcDay(pool, {
      day: day(retrievalAt),
      workspaceId: tenant.workspaceId,
    });
    expect(first.sourceEvents).toBe(10);
    expect(second.sourceEvents).toBe(10);

    const before = await pool.query<{
      retrieval_count: string;
      unique_principal_count: string;
      unique_agent_count: string;
      latency_p50_ms: number;
      latency_p95_ms: number;
      current_version_retrieval_count: string;
    }>(
      `SELECT retrieval_count::text, unique_principal_count::text,
              unique_agent_count::text, latency_p50_ms, latency_p95_ms,
              current_version_retrieval_count::text
         FROM analytics_daily_summary
        WHERE workspace_id = $1 AND day = $2::date AND skill_id = $3`,
      [tenant.workspaceId, day(retrievalAt), tenant.skillId],
    );
    expect(before.rows[0]).toMatchObject({
      retrieval_count: "10",
      unique_principal_count: "1",
      unique_agent_count: "1",
      latency_p50_ms: 14.5,
      current_version_retrieval_count: "10",
    });
    expect(before.rows[0]?.latency_p95_ms).toBeCloseTo(18.55);

    const retention = await runAuditRetention(pool, {
      now: new Date(),
      batchSize: 3,
    });
    expect(retention.deleted).toBe(10);
    expect(retention.batches).toBe(4);

    const detail = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM audit_events
        WHERE workspace_id = $1 AND retention_class = 'detailed_read_90d'`,
      [tenant.workspaceId],
    );
    const permanent = await pool.query<{ event_type: string }>(
      `SELECT event_type FROM audit_events
        WHERE workspace_id = $1
          AND event_type IN (
            'skill.amendment.created',
            'oauth.refresh.reuse_detected'
          )
        ORDER BY event_type`,
      [tenant.workspaceId],
    );
    expect(detail.rows[0]?.count).toBe("0");
    expect(permanent.rows.map((row) => row.event_type)).toEqual([
      "oauth.refresh.reuse_detected",
      "skill.amendment.created",
      "skill.amendment.created",
    ]);

    const after = await pool.query<{ retrieval_count: string }>(
      `SELECT retrieval_count::text
         FROM analytics_daily_summary
        WHERE workspace_id = $1 AND day = $2::date AND skill_id = $3`,
      [tenant.workspaceId, day(retrievalAt), tenant.skillId],
    );
    expect(after.rows[0]?.retrieval_count).toBe("10");
  });

  it("never permits permanent security history through the retention trigger", async () => {
    await expect(
      pool.query(
        `DELETE FROM audit_events
          WHERE workspace_id = $1 AND event_type = 'oauth.refresh.reuse_detected'`,
        [tenant.workspaceId],
      ),
    ).rejects.toMatchObject({ code: "55000" });
  });
});
