import { describe, expect, it } from "vitest";
import { rollupUtcDay } from "./rollups.js";

describe("UTC rollup validation", () => {
  it("rejects malformed days before querying Postgres", async () => {
    const pool = {
      query() {
        throw new Error("query should not run");
      },
    };
    await expect(rollupUtcDay(pool as never, { day: "07/26/2026" })).rejects.toThrow(
      "YYYY-MM-DD",
    );
  });
});
