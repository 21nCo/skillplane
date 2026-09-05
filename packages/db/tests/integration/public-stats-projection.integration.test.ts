import {
  applyPublicStatsProjectionCheckpoint,
  cleanupPublicStatsProjectionEvents,
} from "@skillplane/control-plane";
import { Pool } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { migrateDatabase, resolveTestDatabaseUrl } from "../../src/index.js";

let databaseUrl: string;

beforeAll(async () => {
  databaseUrl = await resolveTestDatabaseUrl();
  await migrateDatabase(databaseUrl);
});

describe("public stats projection checkpoints", () => {
  it("deduplicates retries after event-ledger cleanup", async () => {
    const pool = new Pool({ connectionString: databaseUrl, max: 1 });
    const suffix = crypto.randomUUID();
    const workspaceId = `workspace:stats-checkpoint:${suffix}`;
    try {
      await pool.query(
        `INSERT INTO workspaces (id, workspace_id, slug, name)
         VALUES ($1, $1, $2, 'Stats checkpoint')`,
        [workspaceId, `stats-checkpoint-${suffix}`],
      );

      const apply = (input: {
        eventId: string;
        fencingEpoch: number;
        sequence: number;
        agentSkillUses: number;
      }) =>
        applyPublicStatsProjectionCheckpoint({
          database: pool,
          workspaceId,
          eventType: "public_stats.agent_skill_used",
          totalSkills: 0,
          ...input,
        });

      await apply({
        eventId: `event:${suffix}:one`,
        fencingEpoch: 1,
        sequence: 1,
        agentSkillUses: 1,
      });
      await apply({
        eventId: `event:${suffix}:one`,
        fencingEpoch: 1,
        sequence: 1,
        agentSkillUses: 1,
      });
      await apply({
        eventId: `event:${suffix}:two`,
        fencingEpoch: 1,
        sequence: 3,
        agentSkillUses: 2,
      });

      await pool.query(
        `DELETE FROM public_stats_projection_events
          WHERE event_id = $1`,
        [`event:${suffix}:one`],
      );
      await apply({
        eventId: `event:${suffix}:one`,
        fencingEpoch: 1,
        sequence: 1,
        agentSkillUses: 1,
      });

      const result = await pool.query<{
        agent_skill_uses: string;
        fencing_epoch: string;
        sequence: string;
      }>(
        `SELECT counter.agent_skill_uses::text,
                checkpoint.fencing_epoch::text,
                checkpoint.sequence::text
           FROM public_stats_counters counter
           JOIN public_stats_projection_checkpoints checkpoint
             ON checkpoint.workspace_id = counter.id
          WHERE counter.id = $1`,
        [workspaceId],
      );
      expect(result.rows).toEqual([
        { agent_skill_uses: "3", fencing_epoch: "1", sequence: "3" },
      ]);

      await pool.query(
        `UPDATE public_stats_projection_events
            SET applied_at = now() - interval '8 days'
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      await expect(
        cleanupPublicStatsProjectionEvents({
          database: pool,
          retentionSeconds: 7 * 24 * 60 * 60,
        }),
      ).resolves.toBeGreaterThan(0);
      const retained = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM public_stats_projection_events
          WHERE workspace_id = $1`,
        [workspaceId],
      );
      expect(retained.rows[0]?.count).toBe("0");
    } finally {
      await pool.query("DELETE FROM workspaces WHERE id = $1", [workspaceId]);
      await pool.end();
    }
  });
});
