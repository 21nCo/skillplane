import type * as MigrationModule from "./migration.js";
import { beforeEach, expect, it, vi } from "vitest";
import { migrateLegacyWorkspaceBatch } from "./legacy-cutover.js";
import { migrateWorkspaceWithJournal, runWorkspaceRollbackDrill } from "./migration.js";
import { createPostgresWorkspacePlacementDirectory } from "./placement.js";

vi.mock("./concrete-migration.js", () => ({
  PostgresWorkspaceMigrationOperations: vi.fn(function () {
    return {};
  }),
}));
vi.mock("./placement.js", () => ({
  createPostgresWorkspacePlacementDirectory: vi.fn(),
}));
vi.mock("./migration.js", async (original) => ({
  ...(await original<typeof MigrationModule>()),
  PostgresWorkspaceMigrationJournal: vi.fn(function () {
    return {};
  }),
  migrateWorkspaceWithJournal: vi.fn(),
  runWorkspaceRollbackDrill: vi.fn(),
}));
beforeEach(() => vi.resetAllMocks());

it.each(["active", "moving"] as const)(
  "certifies only a completed drill for %s placement",
  async (state) => {
    const placement = {
      namespace: "workspace:test",
      regionId: "legacy",
      epoch: 2,
      state,
      updatedAt: new Date().toISOString(),
    };
    vi.mocked(createPostgresWorkspacePlacementDirectory).mockReturnValue({
      get: async () => placement,
    } as ReturnType<typeof createPostgresWorkspacePlacementDirectory>);
    vi.mocked(migrateWorkspaceWithJournal).mockResolvedValue({ proof: {} } as Awaited<
      ReturnType<typeof migrateWorkspaceWithJournal>
    >);
    const pool = {
      query: vi
        .fn()
        .mockResolvedValue({ rows: [{ workspace_id: placement.namespace }] }),
      connect: vi.fn(),
    };
    const objects = {
      read: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      putIfAbsent: vi.fn(),
    };
    await migrateLegacyWorkspaceBatch({
      control: pool,
      source: pool,
      target: pool,
      sourceObjects: objects,
      targetObjects: objects,
      targetRegionId: "in-south",
    });
    expect(runWorkspaceRollbackDrill).toHaveBeenCalledTimes(state === "active" ? 1 : 0);
    expect(migrateWorkspaceWithJournal).toHaveBeenCalledWith(
      expect.objectContaining({ rollbackTested: state === "active" }),
    );
  },
);
