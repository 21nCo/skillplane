import { describe, expect, it, vi } from "vitest";
import { setCurrentWorkspaceRoutingEpoch } from "./routing-epoch.js";

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
});
