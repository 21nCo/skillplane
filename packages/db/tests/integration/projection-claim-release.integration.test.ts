import { drainRegionalProjectionOutbox } from "@skillplane/control-plane";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { resolveTestDatabaseUrl } from "../../src/index.js";

it("releases only unused batch claims and makes them immediately reclaimable", async () => {
  const pool = new Pool({ connectionString: await resolveTestDatabaseUrl(), max: 1 });
  const client = await pool.connect();
  let clock = 0;
  const time = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    // A connection-local table exercises the real claim/release SQL without shared fixtures.
    await client.query(`CREATE TEMP TABLE regional_projection_outbox (
      id text PRIMARY KEY, workspace_id text NOT NULL, event_type text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}', fencing_epoch bigint NOT NULL DEFAULT 1,
      sequence bigint NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz, claim_token text, processed_at timestamptz,
      attempts integer NOT NULL DEFAULT 0, last_error text
    )`);
    await client.query(`INSERT INTO regional_projection_outbox (id, workspace_id, event_type)
      VALUES ('1', 'one', 'public_stats.agent_skill_used'),
             ('2', 'two', 'public_stats.agent_skill_used'),
             ('3', 'three', 'public_stats.agent_skill_used')`);
    // Another invocation deliberately uses the same public token.
    await client.query(
      `UPDATE regional_projection_outbox SET claim_token = 'shared', claimed_at = now() WHERE id = '3'`,
    );
    const options = {
      regionId: "in-south",
      database: client,
      claimToken: "shared",
      limit: 25,
    };
    expect(
      await drainRegionalProjectionOutbox({
        ...options,
        maxDurationMs: 20,
        process: async () => {
          clock = 100;
        },
      }),
    ).toEqual({ processed: 1, failed: 0 });
    const state = await client.query(
      `SELECT id, claim_token, claimed_at, processed_at FROM regional_projection_outbox ORDER BY id`,
    );
    expect(state.rows[0].processed_at).not.toBeNull();
    expect(state.rows[1]).toMatchObject({
      id: "2",
      claim_token: null,
      claimed_at: null,
      processed_at: null,
    });
    expect(state.rows[2].claim_token).toBe("shared");
    expect(state.rows[2].claimed_at).not.toBeNull();
    const reclaimed: string[] = [];
    expect(
      await drainRegionalProjectionOutbox({
        ...options,
        claimToken: "next",
        process: async (event) => {
          reclaimed.push(event.id);
        },
      }),
    ).toEqual({ processed: 1, failed: 0 });
    expect(reclaimed).toEqual(["2"]);
  } finally {
    time.mockRestore();
    client.release();
    await pool.end();
  }
});
