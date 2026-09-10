import { expect, it, vi } from "vitest";
import { cleanupProjectionRetention } from "./retention.js";

function inventory(size: number, onQuery = () => undefined) {
  const remaining = { regional: size, stats: size, audit: size };
  const database = {
    async query(sql: string, values?: readonly unknown[]) {
      onQuery();
      const kind = sql.includes("regional_projection_outbox")
        ? "regional"
        : sql.includes("public_stats_projection_events")
          ? "stats"
          : "audit";
      const limit = kind === "audit" ? 5000 : Number(values?.[1]);
      const count = Math.min(remaining[kind], limit);
      remaining[kind] -= count;
      return { rows: Array.from({ length: count }, () => ({ id: "expired-row" })) };
    },
  };
  return { remaining, regionalDatabase: database, controlDatabase: database };
}

it("can retire more rows than a maximum ingestion invocation in every stream", async () => {
  const clock = vi.spyOn(performance, "now").mockReturnValue(0);
  try {
    const data = inventory(55_001);
    expect(await cleanupProjectionRetention(data)).toEqual([55_001, 55_001, 55_001]);
    expect(data.remaining).toEqual({ regional: 0, stats: 0, audit: 0 });
  } finally {
    clock.mockRestore();
  }
});

it("stops starting batches at the shared deadline and resumes retained rows later", async () => {
  let time = 0;
  const starts: number[] = [];
  const clock = vi.spyOn(performance, "now").mockImplementation(() => time);
  try {
    const data = inventory(10_001, () => {
      starts.push(time);
      time += 2;
    });
    expect(await cleanupProjectionRetention({ ...data, maxDurationMs: 5 })).toEqual([
      5000, 5000, 5000,
    ]);
    expect(starts.every((start) => start < 5)).toBe(true);
    expect(data.remaining).toEqual({ regional: 5001, stats: 5001, audit: 5001 });
    await cleanupProjectionRetention(data);
    expect(data.remaining).toEqual({ regional: 0, stats: 0, audit: 0 });
  } finally {
    clock.mockRestore();
  }
});
