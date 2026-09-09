import { expect, it, vi } from "vitest";
import { drainRegionalProjectionOutbox } from "./projection-outbox.js";

it("drains beyond 100 while preserving the deadline and per-workspace failure exclusion", async () => {
  let clock = 0;
  let issued = 0;
  let excluded = false;
  const time = vi.spyOn(performance, "now").mockImplementation(() => clock);
  try {
    const result = await drainRegionalProjectionOutbox({
      regionId: "in-south",
      limit: 50_000,
      maxDurationMs: 450,
      database: {
        async query(sql, values) {
          if (sql.includes("WITH candidates")) {
            expect(values?.[0]).toBe(25);
            if (issued > 0) excluded = (values?.[3] as string[]).includes("poison");
            issued++;
            return {
              rows: [
                {
                  id: String(issued),
                  workspace_id: issued === 1 ? "poison" : "active",
                  event_type: "public_stats.agent_skill_used",
                  payload: {},
                  fencing_epoch: 1,
                  sequence: issued,
                },
              ],
            };
          }
          return { rows: [{ id: String(issued) }] };
        },
      },
      process: async (event) => {
        clock += 2;
        if (event.workspaceId === "poison") throw new Error("bad");
      },
    });
    expect(result).toEqual({ processed: 224, failed: 1 });
    expect(excluded).toBe(true);
    expect(issued).toBe(225);
  } finally {
    time.mockRestore();
  }
});
