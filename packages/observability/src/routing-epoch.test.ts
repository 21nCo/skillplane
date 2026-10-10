import { describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceRoutingEpoch } from "./routing-epoch.js";
import { rollupUtcDay } from "./rollups.js";

describe("regional maintenance routing epoch", () => {
  it("locks and installs the current active ownership generation", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("SELECT source_epoch::text")
        ? { rows: [{ source_epoch: "0", active_epoch: "6" }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    await expect(
      setCurrentWorkspaceRoutingEpoch({ query } as never, "workspace:test"),
    ).resolves.toBe(6);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("workspace_routing_epoch"),
      ["6"],
    );
  });

  it("does not bypass a raised source migration fence", async () => {
    const query = vi.fn(async (sql: string) =>
      sql.includes("SELECT source_epoch::text")
        ? { rows: [{ source_epoch: "5", active_epoch: "6" }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
    );

    await expect(
      setCurrentWorkspaceRoutingEpoch({ query } as never, "workspace:test"),
    ).rejects.toThrow("WORKSPACE_MAINTENANCE_FENCED");
  });

  it("does not treat a missing or corrupt fence as a migrated workspace", async () => {
    for (const rows of [[], [{ source_epoch: "0", active_epoch: "invalid" }]]) {
      const client = {
        query: vi.fn(async (sql: string) => ({
          rows: sql.includes("SELECT source_epoch::text") ? rows : [],
        })),
        release: vi.fn(),
      };
      const pool = { connect: async () => client };
      await expect(
        rollupUtcDay(pool as never, {
          day: "2026-01-01",
          workspaceId: "workspace:corrupt",
        }),
      ).rejects.toThrow("WORKSPACE_MAINTENANCE_EPOCH_INVALID");
      expect(client.query).toHaveBeenCalledWith("ROLLBACK");
      expect(client.release).toHaveBeenCalled();
    }
  });
});
