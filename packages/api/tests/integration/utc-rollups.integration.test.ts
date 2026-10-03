import {
  assertDisposableDatabaseUrl,
  migrateDatabase,
  resolveTestDatabaseUrl,
} from "@skillplane/db";
import { rollupUtcDay, writeAuditEvent } from "@skillplane/observability";
import { Pool } from "pg";
import { expect, it } from "vitest";

it.each([
  ["UTC", "2026-03-08"],
  ["Asia/Kolkata", "2026-03-08"],
  ["America/New_York", "2026-03-08"],
  ["America/New_York", "2026-11-01"],
])(
  "rolls up UTC boundaries in %s on %s",
  async (timezone, day) => {
    const name = `utc_rollups_${crypto.randomUUID().replaceAll("-", "").slice(0, 10)}_test`;
    const databaseUrl = await resolveTestDatabaseUrl();
    assertDisposableDatabaseUrl(databaseUrl);
    const address = new URL(databaseUrl);
    address.searchParams.delete("options");
    address.pathname = "/postgres";
    const admin = new Pool({ connectionString: address.toString() });
    let created = false;
    let database: Pool | undefined;
    try {
      await admin.query(`CREATE DATABASE "${name}" TEMPLATE template0`);
      created = true;
      address.pathname = `/${name}`;
      database = new Pool({
        connectionString: address.toString(),
        options: `-c timezone=${timezone}`,
        max: 2,
      });
      const start = new Date(`${day}T00:00:00.000Z`).getTime();
      const end = start + 86_400_000;
      const expectedLatest = new Date(end - 1);
      await migrateDatabase(address.toString());
      expect((await database.query("SHOW TimeZone")).rows[0]?.TimeZone).toBe(timezone);
      for (const workspaceId of ["main", "early", "late", "outside"]) {
        await database.query(
          "INSERT INTO workspaces (id, workspace_id, slug, name) VALUES ($1, $1, $1, $1)",
          [workspaceId],
        );
      }
      for (const [workspaceId, label, timestamp] of [
        ["main", "before", start - 1],
        ["main", "start", start],
        ["main", "middle", start + 12 * 3_600_000],
        ["main", "end", end - 1],
        ["main", "after", end],
        ["early", "start", start],
        ["late", "end", end - 1],
        ["outside", "before", start - 1],
        ["outside", "after", end],
      ] as const) {
        await writeAuditEvent(database, {
          workspaceId,
          eventType: "mcp.skill_retrieve.success",
          action: "skill_retrieve",
          outcome: label === "before" || label === "after" ? "error" : "success",
          actorType: "system",
          actorId: `actor:${label}`,
          requestId: `${workspaceId}:${label}`,
          skillId: "skill:utc",
          versionId: `version:${label}`,
          agent: `agent:${label}`,
          model: `model:${label}`,
          contextId: `context:${label}`,
          ...(label === "middle" ? { latencyMs: 12.5 } : {}),
          retentionClass: "detailed_read_90d",
          occurredAt: new Date(timestamp),
        });
      }

      await expect(rollupUtcDay(database, { day })).resolves.toEqual({
        day,
        workspaces: 3,
        sourceEvents: 5,
      });
      // An explicit-workspace rebuild must use the same window as discovery.
      await expect(
        rollupUtcDay(database, { day, workspaceId: "main" }),
      ).resolves.toEqual({ day, workspaces: 1, sourceEvents: 3 });

      const runs = await database.query(
        `SELECT workspace_id, source_event_count::text, source_latest_event_at
         FROM analytics_rollup_runs WHERE day = $1::date ORDER BY workspace_id`,
        [day],
      );
      expect(runs.rows).toEqual([
        {
          workspace_id: "early",
          source_event_count: "1",
          source_latest_event_at: new Date(start),
        },
        {
          workspace_id: "late",
          source_event_count: "1",
          source_latest_event_at: expectedLatest,
        },
        {
          workspace_id: "main",
          source_event_count: "3",
          source_latest_event_at: expectedLatest,
        },
      ]);
      const summary = await database.query(
        `SELECT skill_id, event_count::text, retrieval_count::text, failure_count::text,
                latency_p50_ms, latency_p95_ms
         FROM analytics_daily_summary
        WHERE workspace_id = 'main' AND day = $1::date ORDER BY skill_id`,
        [day],
      );
      expect(summary.rows).toEqual(
        ["", "skill:utc"].map((skillId) => ({
          skill_id: skillId,
          event_count: "3",
          retrieval_count: "3",
          failure_count: "0",
          latency_p50_ms: 12.5,
          latency_p95_ms: 12.5,
        })),
      );
      const dimensions = await database.query(
        `SELECT skill_id, dimension_type, dimension_value, event_count::text,
              failure_count::text
         FROM analytics_daily_dimensions
        WHERE workspace_id = 'main' AND day = $1::date
        ORDER BY dimension_type, dimension_value`,
        [day],
      );
      for (const skillId of ["", "skill:utc"]) {
        const rows = dimensions.rows.filter((row) => row.skill_id === skillId);
        expect(rows).toHaveLength(14);
        for (const type of ["agent", "model", "context", "version"]) {
          expect(rows.filter((row) => row.dimension_type === type)).toEqual(
            ["end", "middle", "start"].map((label) => ({
              skill_id: skillId,
              dimension_type: type,
              dimension_value: `${type}:${label}`,
              event_count: "1",
              failure_count: "0",
            })),
          );
        }
        for (const [type, value] of [
          ["tool", "skill_retrieve"],
          ["outcome", "success"],
        ]) {
          expect(rows.filter((row) => row.dimension_type === type)).toEqual([
            {
              skill_id: skillId,
              dimension_type: type,
              dimension_value: value,
              event_count: "3",
              failure_count: "0",
            },
          ]);
        }
      }
    } finally {
      try {
        await database?.end();
      } finally {
        try {
          if (created) await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
        } finally {
          await admin.end();
        }
      }
    }
  },
  90_000,
);
